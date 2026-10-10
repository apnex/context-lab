import fs from "node:fs";
import path from "node:path";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
for (const f of fs.readdirSync(input.from)) fs.writeFileSync(path.join(input.to, f), fs.readFileSync(path.join(input.from, f), "utf8").trim() + "\n");
console.log(JSON.stringify({ written: fs.readdirSync(input.to) }));
