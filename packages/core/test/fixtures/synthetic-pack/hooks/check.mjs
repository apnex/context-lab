import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
console.log(JSON.stringify({ defects: [], checked: input.pack.id }));
