import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/shared/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2] ?? 'up';
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig(url, 2));
const migrator = orm.getMigrator();
try {
  if (command === 'up') {
    const done = await migrator.up();
    console.log(JSON.stringify({ msg: 'migrations applied', migrations: done.map((m) => m.name) }));
  } else if (command === 'down') {
    const target = process.argv[3] === '--all' ? { to: 0 } : undefined;
    const done = await migrator.down(target);
    console.log(JSON.stringify({ msg: 'migrations reverted', migrations: done.map((m) => m.name) }));
  } else if (command === 'create') {
    const res = await migrator.createMigration('./migrations', true);
    console.log(JSON.stringify({ msg: 'migration created', file: res.fileName }));
  } else {
    console.error(`Unknown command ${command}. Use up | down [--all] | create`);
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
