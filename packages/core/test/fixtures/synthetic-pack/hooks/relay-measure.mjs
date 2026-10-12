import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
console.log(JSON.stringify({ scores: { "relay-5": String(input.outcome.final).includes("WORK-FINAL-MARKER") ? 1 : 0 } }));
