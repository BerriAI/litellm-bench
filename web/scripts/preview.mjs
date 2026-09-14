import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const directory = resolve(process.env.BENCHMARK_SITE_DIR ?? "dist");
const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.BASE_PATH
  ?? (repository && !repository.endsWith(".github.io") ? `/${repository}` : "");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
const port = Number(process.env.PORT ?? 4173);
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (base && pathname === base) {
      response.writeHead(308, { location: `${base}/` }).end();
      return;
    }
    if (!pathname.startsWith(`${base}/`)) throw new Error("Not found");
    let file = resolve(directory, `.${pathname.slice(base.length)}`);
    if (file !== directory && !file.startsWith(`${directory}${sep}`)) throw new Error("Not found");
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    const content = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}${base}/`));
