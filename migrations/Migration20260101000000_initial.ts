import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee of section 6 of the challenge is enforced here,
 * not only in application code:
 *  - one wallet per (player, currency)             → uq_wallets_player_currency
 *  - balance never negative                         → CHECK (balance >= 0)
 *  - every balance change has exactly one entry     → deferred constraint trigger + uq (wallet_id, wallet_version)
 *  - ledger immutable (append-only)                 → BEFORE UPDATE/DELETE trigger
 *  - ledger arithmetic                              → ck_ledger_balanced
 *  - ≤ 1 ledger entry per transaction               → uq_ledger_transaction
 *  - ledger currency == wallet currency             → composite FK (wallet_id, currency)
 *  - idempotency                                    → uq_wt_idempotency_key, uq_wt_provider_external
 *  - a reference is reversed at most once           → uq_wt_reversal_once (partial unique index)
 *  - inbox dedup                                    → PK (consumer_name, message_id)
 */
export class Migration20260101000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
        version     integer NOT NULL CHECK (version >= 1),
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 255),
        external_transaction_id           text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 255),
        idempotency_key                   text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
        payload_hash                      char(64) NOT NULL,
        wallet_id                         uuid NOT NULL,
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL
                                            CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions(id),
        status                            text NOT NULL
                                            CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        observed_balance                  numeric(20,2) CHECK (observed_balance >= 0),
        reference_attempts                integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT uq_wt_idempotency_key   UNIQUE (idempotency_key),
        CONSTRAINT uq_wt_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wt_reference_required CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT ck_wt_terminal_processed_at CHECK (
          (status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)
        ),
        CONSTRAINT ck_wt_failure_code CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT ck_wt_pending_reference_schedule CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)
        )
      );
    `);
    // Rule 4: a reference can be reversed (REFUND/ROLLBACK) at most once.
    this.addSql(`
      CREATE UNIQUE INDEX uq_wt_reversal_once ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_wt_pending_reference ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_wt_waiting_on_reference ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql('CREATE INDEX ix_wt_wallet_created ON wager_transactions (wallet_id, created_at);');

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid PRIMARY KEY,
        wallet_id       uuid NOT NULL,
        transaction_id  uuid NOT NULL REFERENCES wager_transactions(id),
        direction       text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CHECK (amount > 0),
        currency        char(3) NOT NULL,
        balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version  integer NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz NOT NULL,
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql('CREATE INDEX ix_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, id);');

    // Append-only ledger.
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    // Balance ↔ ledger coupling, checked at COMMIT (deferred):
    //  - INSERT with balance > 0 needs the opening entry (version 1, 0 → balance);
    //  - UPDATE that changes balance must bump version by exactly 1 and have the matching entry;
    //  - UPDATE that keeps balance must keep version.
    this.addSql(`
      CREATE FUNCTION check_wallet_ledger_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must be created with version 1', NEW.id USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.balance > 0 AND NOT EXISTS (
            SELECT 1 FROM wallet_ledger_entries l
             WHERE l.wallet_id = NEW.id AND l.wallet_version = 1
               AND l.direction = 'CREDIT' AND l.balance_before = 0 AND l.balance_after = NEW.balance
          ) THEN
            RAISE EXCEPTION 'wallet % opened with balance but without opening ledger entry', NEW.id
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END IF;

        IF OLD.balance = NEW.balance THEN
          IF OLD.version <> NEW.version THEN
            RAISE EXCEPTION 'wallet % version changed without balance change', NEW.id USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END IF;

        IF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance change must bump version by 1', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries l
           WHERE l.wallet_id = NEW.id AND l.wallet_version = NEW.version
             AND l.balance_before = OLD.balance AND l.balance_after = NEW.balance
        ) THEN
          RAISE EXCEPTION 'wallet % balance changed without matching ledger entry', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_ledger_coupling
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_coupling();
    `);
    this.addSql(`
      CREATE FUNCTION forbid_wallet_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_wallet_delete();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text NOT NULL,
        message_id     text NOT NULL,
        payload_hash   char(64) NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid PRIMARY KEY,
        aggregate_id     text NOT NULL,
        event_type       text NOT NULL,
        payload          jsonb NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_pending ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_no_delete ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_ledger_coupling ON wallets;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS forbid_wallet_delete();');
    this.addSql('DROP FUNCTION IF EXISTS check_wallet_ledger_coupling();');
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_mutation();');
  }
}
