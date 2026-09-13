const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  const m = s.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { console.log(f + ': no dc script'); process.exitCode = 1; continue; }
  try { new Function(m[1]); console.log(f + ': OK'); }
  catch (e) { console.log(f + ': ' + e.message); process.exitCode = 1; }
}
