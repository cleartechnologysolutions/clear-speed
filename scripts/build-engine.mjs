import {build} from 'esbuild';
import {writeFile,copyFile} from 'node:fs/promises';
const result=await build({entryPoints:['node_modules/@cloudflare/speedtest/dist/speedtest.js'],bundle:true,format:'iife',globalName:'CFEngine',platform:'browser',target:'es2022',minify:true,write:false});
await writeFile('vendor/cloudflare-engine.js','// Generated from @cloudflare/speedtest 1.14.1. See CLOUDFLARE-LICENSE.txt.\nexport const CF_ENGINE = '+JSON.stringify(result.outputFiles[0].text)+';\n');
await copyFile('node_modules/@cloudflare/speedtest/LICENSE','vendor/CLOUDFLARE-LICENSE.txt');
