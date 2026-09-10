import { createPool } from "./store/pool.js";
import { LiveStateProjector } from "./store/liveProjector.js";
import { bootstrapApp } from "./api/server.js";

// Per this project's process-safety rules: never bind a fixed port a real
// service might want. PORT=0 (the default here) asks the OS for a free
// ephemeral port, and the actual bound port is printed so a caller (a human,
// or the Playwright test that spawns this file as a child process) can read
// it back instead of assuming one.
async function main() {
  const pool = createPool();
  const projector = new LiveStateProjector();
  const app = await bootstrapApp({ pool, projector });

  const port = Number(process.env.PORT ?? 0);
  const server = app.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`LISTENING_ON ${boundPort}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
