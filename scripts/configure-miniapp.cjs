const fs=require('node:fs'),path=require('node:path');
function configure(root,args){
 const o={};for(let i=0;i<args.length;i+=2){if(!['--appid','--base-url','--wechat-si-version'].includes(args[i])||!args[i+1])throw Error('Usage: node scripts/configure-miniapp.cjs --appid wx... --base-url https://... [--wechat-si-version APPROVED_VERSION]');o[args[i]]=args[i+1];}
 if(!/^wx[0-9a-f]{16}$/.test(o['--appid']||''))throw Error('Provide your actual WeChat AppID.');
 const url=new URL(o['--base-url']);if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('API origin only, without credentials, path or query.');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('Phone/release requires HTTPS; HTTP is local DevTools only.');
 const v=o['--wechat-si-version'];if(v&&!/^\d+\.\d+\.\d+$/.test(v))throw Error('Supply an explicitly approved plugin version.');
 const d=path.join(root,'miniapp'),p=JSON.parse(fs.readFileSync(path.join(d,'project.config.json'))),a=JSON.parse(fs.readFileSync(path.join(d,'app.json')));p.appid=o['--appid'];delete a.plugins;delete a.permission;
 if(v){a.plugins={WechatSI:{version:v,provider:'wx069ba97219f66d99'}};a.permission={'scope.record':{desc:'由你主动录音生成待确认的现场说明'}};}
 fs.writeFileSync(path.join(d,'project.config.json'),JSON.stringify(p,null,2)+'\n');fs.writeFileSync(path.join(d,'app.json'),JSON.stringify(a,null,2)+'\n');fs.writeFileSync(path.join(d,'config.js'),'// Public local configuration; never put secrets here.\nmodule.exports = '+JSON.stringify({baseUrl:url.origin,configured:true,voiceEnabled:!!v},null,2)+';\n');return {voiceEnabled:!!v};
}
if(require.main===module){try{console.log(configure(path.resolve(__dirname,'..'),process.argv.slice(2)));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={configure};
