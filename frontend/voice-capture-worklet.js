// Worklet runs off the main UI thread; output stays silent to avoid microphone feedback.
class CampusVoiceCapture extends AudioWorkletProcessor {
 constructor(){super();this.buffer=new Float32Array(2048);this.size=0;this.stopped=false;this.port.onmessage=({data})=>{if(data==='flush'){this.flush();this.stopped=true;this.port.postMessage({type:'flushed'});}};}
 flush(){if(this.size){const samples=this.buffer.slice(0,this.size);this.port.postMessage({type:'samples',samples},[samples.buffer]);this.size=0;}}
 process(inputs){if(this.stopped)return false;const channels=inputs[0];if(!channels?.length)return true;
  for(let i=0;i<channels[0].length;i++){let value=0;for(const c of channels)value+=c[i]/channels.length;this.buffer[this.size++]=value;if(this.size===this.buffer.length)this.flush();}return true;
 }
}
registerProcessor('campus-voice-capture',CampusVoiceCapture);
