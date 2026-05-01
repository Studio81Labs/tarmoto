import { buildApp } from "./server";

const port = Number(process.env.MOCK_BACKEND_PORT ?? 4311);

const app = buildApp();
const server = app.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock-backend listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
