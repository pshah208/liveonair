import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`MatchLens backend listening on port ${port}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
