const { execSync } = require('child_process');

const out = execSync('claude -p "what is 2+2"').toString();
console.log(out);