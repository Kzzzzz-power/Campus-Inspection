// Tencent API reference: https://github.com/Tencent/Face2FaceTranslator/blob/master/pages/index/index.js
// https://github.com/Tencent/Face2FaceTranslator/blob/master/README.md
function voice(wx,enabled,load,update) {
  let plugin,manager,audio,alive=true,recording=false,generation=0;
  const fail=e=>{if(alive) update({voiceError:(e && (e.errMsg||e.message))||'语音失败，请继续编辑文字。'});};
  function init() {
    if(!enabled) throw Error('语音未配置，请直接编辑文字。');
    if(!plugin) plugin=load('WechatSI');
  }
  return {
    start() {try {init(); if(recording)return; manager=plugin.getRecordRecognitionManager();
      manager.onRecognize=r=>{if(alive&&recording)update({voiceText:r.result||''});};
      manager.onStop=r=>{recording=false;if(alive)update({voiceText:r.result||'',recording:false});};
      manager.onError=e=>{recording=false;if(alive)update({recording:false});fail(e);};
      manager.start({lang:'zh_CN'}); recording=true;update({recording:true,voiceError:'',voiceText:''});
    } catch(e){fail(e);} },
    stop() {if(manager&&recording)manager.stop();},
    speak(content) {try {init();const token=++generation;
      if(audio){audio.stop();audio.destroy();audio=null;}
      plugin.textToSpeech({lang:'zh_CN',content,success:r=>{if(!alive||token!==generation)return; if(r.retcode!==0||!r.filename)return fail(Error('语音合成失败，请阅读文字。'));
        audio=wx.createInnerAudioContext();audio.onError(fail);audio.src=r.filename;audio.play();},fail});
    } catch(e){fail(e);} },
    dispose() {alive=false;++generation;recording=false;if(manager){manager.onRecognize=()=>{};manager.onStop=()=>{};manager.onError=()=>{};try{manager.stop();}catch(_){}}if(audio){audio.stop();audio.destroy();audio=null;}}
  };
}
module.exports=voice;
