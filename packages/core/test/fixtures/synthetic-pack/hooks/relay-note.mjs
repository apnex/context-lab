import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const files = [...String(input.diff).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).filter((f) => f !== "NOTE.md");
console.log(JSON.stringify({ note: `Files changed in the earlier session: ${files.join(", ") || "none"}.` }));
