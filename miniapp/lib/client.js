// wx.request accepts ArrayBuffer: https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts
const MAX = 10 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
function utf8(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i+1) >= 0xdc00 && text.charCodeAt(i+1) <= 0xdfff) c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | c >> 6, 128 | c & 63);
    else if (c < 65536) bytes.push(224 | c >> 12,128 | c >> 6 & 63,128 | c & 63);
    else bytes.push(240 | c >> 18,128 | c >> 12 & 63,128 | c >> 6 & 63,128 | c & 63);
  }
  return new Uint8Array(bytes);
}
function format(data) {
  const b = new Uint8Array(data);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg','image/jpeg'];
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return ['png','image/png'];
  if (String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') return ['webp','image/webp'];
  throw Error('照片必须为 JPG、PNG 或 WebP，服务端还将校验实际内容。');
}
function multipart(fields, photos, boundary) {
  if (photos.length > 5) throw Error('最多 5 张照片。');
  const chunks = [], add = s => chunks.push(utf8(s));
  Object.keys(fields).forEach(k => {if (!/^[a-z_]+$/.test(k)) throw Error('无效字段'); add('--'+boundary+'\r\nContent-Disposition: form-data; name="'+k+'"\r\n\r\n'+fields[k]+'\r\n');});
  photos.forEach((p,i) => {
    if (!p.data.byteLength || p.data.byteLength > MAX) throw Error('每张照片须非空且不超过 10 MB。');
    const [ext,type] = format(p.data);
    add('--'+boundary+'\r\nContent-Disposition: form-data; name="photos"; filename="photo-'+i+'.'+ext+'"\r\nContent-Type: '+type+'\r\n\r\n');
    chunks.push(new Uint8Array(p.data)); add('\r\n');
  });
  add('--'+boundary+'--\r\n');
  const size = chunks.reduce((n,c) => n+c.length,0);
  if (size > 5*MAX+65536) throw Error('表单过大。');
  const result = new Uint8Array(size); let offset = 0;
  chunks.forEach(c => {result.set(c,offset); offset += c.length;});
  return result.buffer;
}
function key() { return 'wx-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12); }
function invoke(wx, name, args) { return new Promise((resolve,reject) => wx[name](Object.assign({},args,{success:resolve,fail:reject}))); }
class Client {
  constructor(wx, base) { this.wx=wx; this.base=base.replace(/\/$/,''); this.busy=false; }
  async request(path, method='GET', data, header={}) {
    let res;
    try { res = await invoke(this.wx,'request',{url:this.base+path,method,data,header,timeout:25000}); }
    catch(e) { const error = Error(/timeout/i.test(e.errMsg || '') ? '请求超时，保存结果尚不确定。' : '网络不可用，保存结果尚不确定。'); error.kind=/timeout/i.test(e.errMsg || '')?'timeout':'network'; throw error; }
    let body=res.data;
    if (typeof body === 'string') {try {body=JSON.parse(body);} catch (_) {body=null;}}
    if (res.statusCode < 200 || res.statusCode >= 300) { const e=Error((body && (typeof body.detail==='string'?body.detail:JSON.stringify(body.detail))) || 'HTTP '+res.statusCode); e.status=res.statusCode; throw e; }
    if (!body || typeof body !== 'object') throw Error('响应格式无效，保存结果尚不确定。');
    return body;
  }
  get(path) { return this.request(path); }
  storage(id) { return 'inspectgo-draft-v1:'+this.base+':'+id; }
  draft(id) { return this.wx.getStorageSync(this.storage(id)) || {fields:{inspector_id:'',inspected_at:'',notes:'',result:'',conclusion:'',onsite_confirmed:'false'},photos:[],attempt:null}; }
  save(id,draft) { this.wx.setStorageSync(this.storage(id),copy(draft)); }
  async addPhoto(draft,path) {
    if (draft.attempt) throw Error('先使用原请求确认保存结果。');
    if (draft.photos.length>=5) throw Error('最多 5 张照片。');
    const read=await invoke(this.wx.getFileSystemManager(),'readFile',{filePath:path});
    if (read.data.byteLength>MAX) throw Error('每张照片最多 10 MB。'); format(read.data);
    // saveFile makes camera/album temporary files survive page/app lifecycle.
    const saved=await invoke(this.wx,'saveFile',{tempFilePath:path});
    draft.photos.push({path:saved.savedFilePath,owned:true});
  }
  async verifyPhotos(draft) {
    const photos=[];
    for (const p of draft.photos) {try {const r=await invoke(this.wx.getFileSystemManager(),'readFile',{filePath:p.path}); photos.push({data:r.data});} catch (_) {throw Error('草稿照片已丢失。请核对服务端；未发送草稿可移除后重新选取照片。');}}
    return photos;
  }
  validate(fields) {
    if (!fields.inspector_id.trim() || fields.inspector_id.length>80 || !fields.notes.trim() || fields.notes.length>2000) throw Error('请填写人员（80 字以内）和说明（2000 字以内）。');
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(fields.inspected_at) || !Number.isFinite(Date.parse(fields.inspected_at)) || Date.parse(fields.inspected_at)>Date.now()) throw Error('请填写带时区且不晚于当前时间的 ISO 时间。');
    if (fields.onsite_confirmed !== 'true' || ({normal:'ok',fault:'alarm',unknown:'unknown'})[fields.conclusion] !== fields.result || !fields.conclusion) throw Error('请确认已到现场，并选择相互一致的现场结果与人工结论。');
  }
  async submit(id,draft,review) {
    if (this.busy) throw Error('正在提交，请勿重复操作。');
    this.busy=true;
    try {
      if (!draft.attempt) {
        this.validate(draft.fields);
        if (review.status!=='pending') throw Error('复核已结束，请重新核对。');
        const fields=Object.assign({},draft.fields,{point_id:review.point_id,version:String(review.version),request_id:key()});
        if (review.inspection_round_id) fields.inspection_round_id=review.inspection_round_id;
        await this.verifyPhotos(draft);
        draft.attempt={fields,photos:copy(draft.photos),boundary:'inspectgo-'+key()};
        this.save(id,draft); // Persist immutable retry before the network write.
      }
      const a=draft.attempt;
      const photos=await this.verifyPhotos({photos:a.photos});
      const body=multipart(a.fields,photos,a.boundary);
      const result=await this.request('/api/reviews/'+encodeURIComponent(id)+'/evidence','POST',body,{'content-type':'multipart/form-data; boundary='+a.boundary});
      if (!Number.isInteger(result.record_id) || !result.review || result.review.review_id!==id || !Array.isArray(result.photos) || !result.rerun || typeof result.rerun.status!=='string') throw Error('服务端保存响应不完整；请使用原请求核对。');
      // Cleanup only this successfully saved draft's owned files.
      this.wx.removeStorageSync(this.storage(id));
      for (const p of a.photos) if(p.owned) this.wx.removeSavedFile({filePath:p.path,fail:()=>{}});
      return result;
    } catch(e) {
      if (e.status===409) draft.conflict=true;
      else if(e.status>=400 && e.status<500) draft.attempt=null;
      this.save(id,draft); throw e;
    } finally { this.busy=false; }
  }
  reconcile(id,draft,review) {
    if (!draft.conflict) throw Error('保存结果不确定时必须先原样重试，不能换请求。');
    if (review.status!=='pending') throw Error('复核已结束；草稿已保留，不能覆盖。');
    draft.attempt=null; draft.conflict=false; this.save(id,draft);
  }
}
const labels={pending:'待复核',completed:'已完成',timeout:'已超时',cancelled:'已取消',unknown:'无法确认',established:'成立',blocked:'受阻',normal:'正常',fault:'异常',ok:'正常',alarm:'异常'};
module.exports={Client,utf8,multipart,labels,copy,invoke};
