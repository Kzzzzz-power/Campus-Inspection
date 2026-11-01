// Model output is kept alongside the photograph, never copied into an inspection conclusion.
export function photoJobMessage(job) {
  if (!job) return '尚未生成 AI 描述。原始照片与人工记录保持独立。';
  if (job.status === 'queued' || job.status === 'running') return '正在生成照片辅助描述；可关闭预览，稍后回来查询。';
  if (job.status === 'interrupted') return '生成被中断，尚未取得保存确认。可继续同一次请求。';
  if (job.evidence?.status === 'ok') return '辅助描述已保存，需人工核对；不代表现场覆盖或复核通过。';
  return job.evidence?.error || job.error || '本次未取得可用描述，没有生成替代结论。';
}

export function initPhotoDescription({el, button, api, postJSON}) {
  const dialog = document.getElementById('photo-dialog');
  const panel = el('details', {id:'photo-ai', class:'photo-ai'});
  const output = el('div', {id:'photo-ai-output', class:'photo-ai-output'});
  const message = el('p', {id:'photo-ai-status', role:'status'});
  const configText = el('p', {id:'photo-ai-config', class:'field-hint'}, '正在读取视觉模型配置…');
  const consent = el('input', {type:'checkbox', id:'photo-ai-consent'});
  const submit = button('生成辅助描述', () => generate(), 'btn btn-primary');
  submit.id = 'photo-ai-submit';
  const retry = button('继续查询 / 重试', () => recover(), 'btn btn-secondary');
  retry.id = 'photo-ai-retry';
  panel.append(el('summary', {}, 'AI 照片辅助摘要'), configText,
    el('label', {class:'check-field'}, consent, el('span', {}, '同意将当前照片发送给已配置的视觉模型。仅描述可见内容，不自动判断故障或复核结果。')),
    el('div', {class:'form-actions'}, submit, retry), message, output);
  dialog.append(panel);
  dialog.classList.add('has-photo-ai');

  const requests = new Map();
  let active = null, generation = 0, timer = null, disposed = false;
  const stop = () => {clearTimeout(timer); timer = null;};
  const valid = (entry, token) => !disposed && active === entry && generation === token;
  const busy = entry => entry?.sending || ['queued','running'].includes(entry?.job?.status);
  function controls() {
    const entry = active;
    submit.disabled = !entry || entry.loading || busy(entry) || entry.uncertain || !entry.config?.enabled || !entry.config?.configured || !consent.checked;
    submit.textContent = busy(entry) ? '正在处理…' : entry?.job?.status === 'completed' ? '重新生成描述' : '生成辅助描述';
    submit.setAttribute('aria-busy', String(Boolean(busy(entry))));
    consent.disabled = busy(entry) || Boolean(entry?.uncertain);
    retry.hidden = !(entry?.uncertain || entry?.readError || entry?.job?.status === 'interrupted');
    retry.disabled = Boolean(entry?.sending || entry?.loading);
  }
  function show(entry) {
    configText.textContent = !entry.config ? '模型配置读取失败，暂不可发送照片。' :
      !entry.config.enabled ? '视觉模型尚未启用；已有照片和人工记录仍可查看。' :
      !entry.config.configured ? '视觉模型配置不完整，请在服务端配置。' : `视觉模型：${entry.config.model_label} · 单张照片由你主动发送`;
    message.textContent = entry.readError || (entry.sending ? '正在提交描述请求，保存结果尚未确认。' : entry.uncertain ? '响应未确认。请继续查询或原样重试，避免重复创建请求。' : photoJobMessage(entry.job));
    output.replaceChildren();
    const evidence = entry.job?.evidence;
    if (evidence) {
      const value = evidence.value_json;
      output.append(el('p', {class:'field-hint'}, `MODEL_OUTPUT · ${evidence.evidence_id} · ${evidence.status}`));
      if (evidence.status === 'ok' && value) {
        output.append(el('h3', {}, 'AI 辅助描述 · 待人工核对'), el('p', {}, value.description));
        if (value.observations?.length) output.append(el('ul', {}, ...value.observations.map(text => el('li', {}, text))));
        if (value.limitations?.length) output.append(el('p', {class:'field-hint'}, value.limitations.join('；')));
      }
      output.append(el('p', {class:'field-hint'}, `生成时间 ${evidence.created_at}；照片现场时间见上方原始记录。`));
      output.append(el('details', {}, el('summary', {}, '来源与关联记录'), el('pre', {}, JSON.stringify(evidence, null, 2))));
    }
    controls();
  }
  function schedule(entry, token) {
    stop();
    if (valid(entry, token) && dialog.open && !document.hidden && ['queued','running'].includes(entry.job?.status))
      timer = setTimeout(() => poll(entry, token), 1200);
  }
  async function poll(entry, token) {
    if (!valid(entry, token) || !dialog.open || document.hidden) return;
    const version = entry.readVersion = (entry.readVersion || 0) + 1;
    const current = () => valid(entry, token) && entry.readVersion === version;
    try {const job = await api('/api/photo-descriptions/' + encodeURIComponent(entry.job.description_id)); if (!current()) return; entry.job = job; entry.readError = null;}
    catch (error) {if (!current()) return; entry.readError = error.message;}
    if (!current()) return;
    show(entry);
    if (!entry.readError) schedule(entry, token);
  }
  async function load(entry, token) {
    const version = entry.readVersion = (entry.readVersion || 0) + 1;
    const current = () => valid(entry, token) && entry.readVersion === version;
    entry.loading = true; controls();
    try {
      const [config, data] = await Promise.all([api('/api/photo-descriptions/config'), api(`/api/evidence/images/${entry.imageId}/descriptions`)]);
      if (!current()) return;
      entry.config = config;
      entry.job = data.items[0] || null;
      entry.readError = null;
      if (entry.uncertain && entry.job?.request_id === entry.requestId) entry.uncertain = false;
    } catch (error) {if (!current()) return; entry.readError = error.message;}
    finally {if (current()) entry.loading = false;}
    if (!current()) return;
    show(entry); schedule(entry, token);
  }
  async function generate(resume = false) {
    const entry = active, token = generation;
    if (!entry || entry.sending || (!resume && submit.disabled)) return;
    entry.readVersion = (entry.readVersion || 0) + 1;
    entry.loading = false;
    entry.sending = true; entry.readError = null;
    if (!entry.requestId || (!entry.uncertain && entry.job?.status === 'completed')) entry.requestId = crypto.randomUUID();
    controls(); message.textContent = '正在提交描述请求，等待服务端确认…';
    try {
      entry.job = resume && entry.job?.status === 'interrupted'
        ? await postJSON(`/api/photo-descriptions/${entry.job.description_id}/retry`, {})
        : await postJSON(`/api/evidence/images/${entry.imageId}/descriptions`, {request_id:entry.requestId, consent:true});
      entry.uncertain = false;
    } catch (error) {entry.readError = error.message; entry.uncertain = !error.status || error.status >= 500;}
    finally {entry.sending = false; entry.loading = false; entry.readVersion = (entry.readVersion || 0) + 1;}
    // POST owns this entry even after switching away and back; refresh the current view.
    if (!valid(entry, generation)) return;
    show(entry); schedule(entry, generation);
  }
  async function recover() {
    if (active?.uncertain || active?.job?.status === 'interrupted') return generate(true);
    if (active) return load(active, generation);
  }
  function setPhoto(photo) {
    stop(); generation++;
    const imageId = photo.image_id;
    if (!requests.has(imageId)) requests.set(imageId, {imageId});
    active = requests.get(imageId); consent.checked = false;
    output.replaceChildren(); message.textContent = '正在查询这张照片的辅助摘要…';
    load(active, generation);
  }
  function visibility() {stop(); if (!document.hidden && active && dialog.open) load(active, generation);}
  function pageHide() {stop();}
  function pageShow() {visibility();}
  consent.addEventListener('change', controls);
  dialog.addEventListener('close', stop);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  return {setPhoto, destroy() {disposed = true; generation++; stop(); dialog.removeEventListener('close', stop); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow); panel.remove();}};
}
