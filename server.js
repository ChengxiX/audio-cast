import { createAudioCastServer } from "./src/app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const { server } = createAudioCastServer();

server.listen(port, "127.0.0.1", () => {
  console.log(`win-audio-cast listening on http://127.0.0.1:${port}`);
});
