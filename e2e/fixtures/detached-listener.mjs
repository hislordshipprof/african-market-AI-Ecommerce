import { createServer } from "node:http";

const port = Number(process.argv[2]);
const token = process.argv[3];
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(token);
}).listen(port, "127.0.0.1");
