'use strict';
// D-FLIX starter. Update ke baad app lagataar crash ho to purani files khud wapas laga deta hai.
const fs = require('fs');
const path = require('path');
const U = path.join(__dirname, '..', '_update');
const flag = path.join(U, 'pending.json');
try {
  if (fs.existsSync(flag)) {
    const j = JSON.parse(fs.readFileSync(flag, 'utf8'));
    j.tries = (j.tries || 0) + 1;
    if (j.tries > 2) {                       // 3 baar start hua aur 20 sec chalne se pehle hi band -> update kharab
      const b = path.join(U, 'backup'), m = JSON.parse(fs.readFileSync(path.join(b, 'manifest.json'), 'utf8'));
      m.replaced.forEach((r) => { try { fs.copyFileSync(path.join(b, 'files', r), path.join(__dirname, r)); } catch (e) { /* skip */ } });
      m.added.forEach((r) => { try { fs.unlinkSync(path.join(__dirname, r)); } catch (e) { /* skip */ } });
      let bad = []; try { bad = JSON.parse(fs.readFileSync(path.join(U, 'failed.json'), 'utf8')); } catch (e) { /* none */ }
      bad.push(j.version); fs.writeFileSync(path.join(U, 'failed.json'), JSON.stringify(bad));
      try { fs.unlinkSync(path.join(U, 'installed.json')); } catch (e) { /* none */ }
      fs.unlinkSync(flag);
    } else fs.writeFileSync(flag, JSON.stringify(j));
  }
} catch (e) { /* boot guard kabhi app ko rokta nahi */ }
require('./main.js');
