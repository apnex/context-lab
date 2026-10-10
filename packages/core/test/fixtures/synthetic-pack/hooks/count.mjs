import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const words = String(input.outcome.final).split(/\s+/).filter(Boolean).length;
console.log(JSON.stringify({ scores: { "graft-2": words < 50 ? 1 : 0 } }));
