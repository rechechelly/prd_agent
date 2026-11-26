import { readFileSync } from "node:fs";
import { createPrdDiscussion } from "../src/prd-discussion.mjs";
const discussionStyle = readFileSync(
  new URL("../src/prd-discussion.css", import.meta.url),
  "utf8",
);
const baseStyle = `*{box-sizing:border-box}body{margin:0;background:#f6f5fa;color:#302d3b;font:15px/1.65 "PingFang SC",system-ui,sans-serif}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #d5d1e0;border-radius:7px;background:white;padding:7px 13px}button.active,button[type=submit]{background:#6654bf;color:white}input,textarea{border:1px solid #ccc6da;border-radius:6px;padding:9px;max-width:100%}h1{font-size:23px;margin:0}p{margin:8px 0}.login{max-width:410px;margin:15vh auto;padding:32px;background:white;border:1px solid #e3dfea;border-radius:15px}.login label,.login button{display:block;margin:14px 0}.login input[type=text],.login input[type=password]{display:block;width:100%;margin-top:4px}header{padding:12px 20px;border-bottom:1px solid #ddd;display:flex;align-items:center;justify-content:space-between;gap:12px;background:white}.review{display:grid;grid-template-columns:minmax(0,1fr) 300px;height:calc(100dvh - 67px)}iframe{border:0;width:100%;height:100%;background:white}aside{border-left:1px solid #ddd;padding:15px;overflow:auto}aside textarea,aside input{width:100%;margin:4px 0}#thread p{border-bottom:1px solid #ddd;padding-bottom:8px;white-space:pre-wrap;overflow-wrap:anywhere}#err{color:#a52d37}@media(max-width:760px){header{flex-wrap:wrap}.review{display:block;height:auto}iframe{height:66dvh}.login{margin:12vh 16px}}`;
const page = (title, body, js) =>
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>' +
  title +
  "</title><style>" +
  baseStyle +
  "\n.review.singleFile{display:block;height:calc(100dvh - 67px)}.review.singleFile iframe{height:100%}[hidden]{display:none!important}" +
  discussionStyle +
  "</style>" +
  body +
  "<script>" +
  js +
  "</script></html>";
export const loginPage = page(
  "登录叙页",
  '<form class="login" id="form"><h1>登录叙页</h1><p>进入你的个人产品工作空间。</p><label>账号<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><label><input name="remember" type="checkbox" checked> 在此设备上保持登录 30 天</label><button type="submit">登录</button><p id="err" role="status"></p></form>',
  `const form = document.getElementById('form');
const loginStatus = document.getElementById('err');
form.onsubmit = async (event) => {
  event.preventDefault();
  const fields = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  loginStatus.textContent = '';
  try {
    const response = await fetch('./api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: fields.get('username'),
        password: fields.get('password'),
        remember: fields.has('remember')
      })
    });
    if (!response.ok) throw Error((await response.json()).error);
    location.replace('./');
  } catch (error) {
    loginStatus.textContent = error.message;
    button.disabled = false;
  }
}`,
);
export const sharePage = page(
  "需求评审",
  '<header><h1 id="title">需求评审</h1><div><button id="prd" class="active">图文 PRD</button> <button id="html">交互原型</button></div></header><main class="review"><iframe id="view" title="公开交付物" sandbox="allow-scripts"></iframe><aside class="prd-discussion" id="publicDiscussion"></aside></main><p id="err" role="status"></p>',
  `const createDiscussion = (${createPrdDiscussion.toString()});
const endpoint='../api/public/'+location.pathname.split('/').pop();
const $=key=>document.getElementById(key);
const view=$('view');
let item, which='prd', request=0;
const discussion=createDiscussion($('publicDiscussion'),{
 guest:true,
 async post(data){
  const response=await fetch(endpoint+'/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok)throw Error((await response.json()).error);
  await refresh();
 }
});
function show(){
 const single=Boolean(item.kind);
 if(single)which=item.kind;
 $('prd').parentElement.hidden=single;
 const next=which; $('publicDiscussion').hidden=which!=='prd' && which!=='document';
 document.querySelector('.review').classList.toggle('singleFile',which!=='prd' && which!=='document');
 discussion.unbind();
 view.onload=null;
 if(which==='prd' || which==='document'){
  view.setAttribute('sandbox','allow-same-origin');
  view.onload=()=>{
   if(which!==next||!view.contentDocument?.body)return;
   if(which==='prd' || which==='document')discussion.bind(view.contentDocument,single ? null : ()=>{which='html';show()});
  };
 }else view.setAttribute('sandbox','allow-scripts allow-forms');
 const content=single?item.content:item[which];
 if(which==='html')view.srcdoc=content;
 else {
  const parsed=new DOMParser().parseFromString(content,'text/html');
  const policy=parsed.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  parsed.head.prepend(policy);
  if(which==='document' || which==='prd' && !parsed.head.querySelector('style')){
    const style=parsed.createElement('style');style.textContent='body{max-width:780px;margin:32px auto;padding:0 24px;color:#343545;font:16px/1.75 system-ui,sans-serif}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d6d5dd;padding:6px 10px}';parsed.head.append(style);
  }
  view.srcdoc='<!doctype html>'+parsed.documentElement.outerHTML;
 }
 for(const key of ['html','prd'])$(key).classList.toggle('active',key===which);
}
async function refresh(){
 const version=++request;
 try{
  const response=await fetch(endpoint);
  if(version!==request)return;
  if(!response.ok){
   $('err').textContent='分享链接不可用';view.removeAttribute('srcdoc');
   discussion.disable();discussion.draw([]);item=null;
   if(response.status===404)stream.close();
   return;
  }
  const next=await response.json();
  if(version!==request)return;
  const change=item?.revision!==next.revision;
  item=next;document.title=item.title;$('title').textContent=item.title;$('err').textContent='';
  discussion.draw(item.comments);
  if(change)show();
 }catch(error){$('err').textContent='暂时无法更新评审内容';}
}
for(const key of ['html','prd'])$(key).onclick=()=>{if(item){which=key;show()}};
const stream=new EventSource(endpoint+'/events');
stream.onopen=stream.onmessage=refresh;
refresh();`,
);
