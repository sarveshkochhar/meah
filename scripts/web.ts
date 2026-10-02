/**
 * Standalone MEAH web console.
 *
 * Runs the control plane WITHOUT the MCP stdio server, for configuring and
 * driving workers by hand. Workers started here live in this process only —
 * to see the workers Claude spawns, start the MCP server with MEAH_WEB=true
 * instead, which shares one WorkerManager between both surfaces.
 *
 *   npm start              # http://127.0.0.1:7817
 *   MEAH_WEB_PORT=8080 npm start
 */
import { loadConfig, apiKeyEnvNames } from '../src/config.ts';
import { collectEnvSecrets } from '../src/redact.ts';
import { createLogger } from '../src/logger.ts';
import { ensureWorkspaceRoot } from '../src/runtime/workspace.ts';
import { WorkerManager } from '../src/runtime/manager.ts';
import { startControlPlane } from '../src/web/control-plane.ts';
import { toMeahError } from '../src/errors.ts';

const port = Number(process.env.MEAH_WEB_PORT ?? 7817);

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, collectEnvSecrets(apiKeyEnvNames(config)), {
    component: 'meah-console',
  });
  await ensureWorkspaceRoot(config.workspaceRoot);
  const manager = new WorkerManager({ config, logger });
  const server = await startControlPlane({
    manager,
    config,
    logger,
    port,
    // Claude's own MEAH owns the pool that matters, so stand aside for it.
    yieldable: true,
    onYield: () => {
      process.stdout.write(
        `\nClaude started its own MEAH and claimed the console.\n` +
          `Reopen http://127.0.0.1:${port} — it now shows Claude's workers.\n`,
      );
      void manager.shutdown().then(() => process.exit(0));
    },
  });

  process.stdout.write(`\nMEAH console  http://127.0.0.1:${port}\n`);
  process.stdout.write(
    `providers: ${Object.keys(config.providers).join(', ') || 'none configured'}\n\n`,
  );

  const shutdown = async () => {
    await manager.shutdown();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  const e = toMeahError(err);
  process.stderr.write(`${e.code}: ${e.message}\n${e.hint ? `hint: ${e.hint}\n` : ''}`);
  process.exit(1);
});
