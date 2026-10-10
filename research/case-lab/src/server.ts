// Local UI + JSON API. Runs execute inside this process; config and prompt edits apply to the next run.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { allCases, getCase, loadDir } from "./cases.ts";
import { ROOT, loadEnv, readJson } from "./llm.ts";
import { getCaseResult, getRun, listRuns, selectKeys, startRun } from "./run.ts";

loadEnv();
const PORT = Number(process.env.PORT ?? 5177);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".pdf": "application/pdf", ".csv": "text/plain", ".txt": "text/plain" };
const editable = () => ["config", "prompts"].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => `${d}/${f}`)).sort();

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const body = (req: http.IncomingMessage) => new Promise<string>((ok, fail) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(d)); req.on("error", fail); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const get = req.method === "GET";
    let m: RegExpMatchArray | null;
    if (get && (p === "/" || /^\/(app\.js|style\.css)$/.test(p))) {
      const file = p === "/" ? "index.html" : p.slice(1);
      return send(res, 200, fs.readFileSync(path.join(ROOT, "ui", file)), TYPES[path.extname(file)]);
    }
    if (p === "/api/runs" && get) return send(res, 200, listRuns());
    if (p === "/api/runs" && req.method === "POST") {
      const b = JSON.parse(await body(req));
      // dir: a folder of handed cases. Its answers and traces go to the repo's ANSWERS/ and logs/, as from the CLI.
      const handed = b.dir ? loadDir(b.dir) : undefined;
      const repo = path.resolve(ROOT, "../..");
      const run = handed
        ? startRun({ label: b.label, keys: handed.map((c) => c.key), overrides: { ...b.overrides, runJudge: false, runReviewer: false }, out: { answers: path.join(repo, "ANSWERS"), logs: path.join(repo, "logs") }, timeoutMin: 15, dir: path.resolve(b.dir) })
        : startRun({ label: b.label, keys: selectKeys(b), overrides: b.overrides });
      run.done.catch((e) => console.error(`run ${run.id} failed:`, e)); // keep the server up if a run dies
      return send(res, 200, { id: run.id });
    }
    if (get && (m = p.match(/^\/api\/runs\/([^/]+)$/))) return send(res, 200, getRun(m[1]));
    if (get && (m = p.match(/^\/api\/runs\/([^/]+)\/cases\/([^/]+)$/))) {
      const dir = getRun(m[1]).dir; // a run over a handed folder: its cases are read from that folder again
      if (dir && fs.existsSync(dir)) loadDir(dir);
      return send(res, 200, { result: getCaseResult(m[1], m[2]), case: getCase(m[2]) });
    }
    if (get && p === "/api/cases") return send(res, 200, { cases: allCases().map((c) => ({ key: c.key, track: c.track, title: c.title, events: c.events.length })), splits: readJson("config/splits.json") });
    if (get && (m = p.match(/^\/api\/cases\/([^/]+)\/(files|text)\/(.+)$/))) {
      const c = getCase(m[1]);
      const name = decodeURIComponent(m[3]);
      if (!c.attachments.some((a) => a.name === name)) return send(res, 404, { error: "no such attachment" });
      if (m[2] === "files") return send(res, 200, fs.readFileSync(c.attachments.find((a) => a.name === name)?.file ?? path.join(c.dir, "attachments", name)), TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream");
      const cached = path.join(ROOT, "cache/extracted", c.key, `${name}.md`);
      return fs.existsSync(cached) ? send(res, 200, fs.readFileSync(cached, "utf8"), "text/plain") : send(res, 404, { error: "not extracted yet" });
    }
    if (p === "/api/files") {
      const f = url.searchParams.get("path");
      if (get && !f) return send(res, 200, editable());
      if (!f || !editable().includes(f)) return send(res, 404, { error: "only existing files in config/ and prompts/ can be read or edited" });
      if (get) return send(res, 200, fs.readFileSync(path.join(ROOT, f), "utf8"), "text/plain");
      if (req.method === "PUT") {
        const text = await body(req);
        if (f.endsWith(".json")) try { JSON.parse(text); } catch (e) { return send(res, 400, { error: `Not valid JSON: ${(e as Error).message}` }); }
        fs.writeFileSync(path.join(ROOT, f), text);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Case Lab: http://localhost:${PORT}`));
