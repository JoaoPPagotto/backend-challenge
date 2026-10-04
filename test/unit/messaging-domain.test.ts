import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/inbox/domain/inbox-message';
import { OutboxMessage } from '../../src/outbox/domain/outbox-message';
import { Money } from '../../src/shared/domain/money/money';
import { canonicalJson, wagerPayloadHash } from '../../src/wagering/application/canonical-json';
import { WalletBalanceChanged } from '../../src/wagering/application/events/wagering-events';
import { Wallet } from '../../src/wallet/domain/wallet';

const at = new Date('2026-07-29T15:00:00.000Z');

describe('canonical JSON / payload hash', () => {
  const payload = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p',
    walletId: 'w',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('key order does not matter', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as typeof payload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test('money is normalized before hashing', () => {
    expect(wagerPayloadHash({ ...payload, money: { amount: '25.0', currency: 'BRL' } })).toBe(
      wagerPayloadHash(payload),
    );
  });

  test('any business field changes the hash; transport fields are ignored', () => {
    const h = wagerPayloadHash(payload);
    expect(wagerPayloadHash({ ...payload, roundId: 'x' })).not.toBe(h);
    expect(wagerPayloadHash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(h);
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: 'r' })).not.toBe(h);
    expect(wagerPayloadHash({ ...payload, idempotencyKey: 'other', messageId: 'm' } as typeof payload)).toBe(
      h,
    );
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('InboxMessage', () => {
  test('markProcessed is idempotent', () => {
    const m = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at);
    m.markProcessed(new Date(at.getTime() + 1000));
    expect(m.processedAt).toEqual(at);
  });
});

describe('OutboxMessage + IntegrationEvent', () => {
  const wallet = Wallet.open({
    id: 'w',
    playerId: 'p',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    at,
  });
  const entry = wallet.debit(Money.from({ amount: '2.50', currency: 'BRL' }), {
    ledgerEntryId: 'e',
    transactionId: 't',
    at,
  });
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: 'ev-1',
    correlationId: 'corr',
    causationId: 'cause',
    occurredAt: at,
  });

  test('envelope is stable JSON with MoneyProps and ISO date', () => {
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'ev-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w',
      correlationId: 'corr',
      causationId: 'cause',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w',
        transactionId: 't',
        direction: 'DEBIT',
        money: { amount: '2.50', currency: 'BRL' },
        balanceBefore: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '7.50', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('enqueue / due / publish', () => {
    const o = OutboxMessage.enqueue(event);
    expect(o.id).toBe('ev-1');
    expect(o.isPending()).toBe(true);
    expect(o.isDue(at)).toBe(true);
    o.markPublished(at);
    expect(o.isPending()).toBe(false);
    expect(o.isDue(at)).toBe(false);
  });

  test('scheduleRetry uses exponential backoff capped at max', () => {
    const o = OutboxMessage.enqueue(event);
    const policy = { baseMs: 1000, maxMs: 8000, jitterMs: 0 };
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      o.scheduleRetry(at, policy, () => 0);
      delays.push((o.nextAttemptAt?.getTime() ?? 0) - at.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(o.attempts).toBe(6);
    expect(o.isDue(at)).toBe(false);
  });
});
