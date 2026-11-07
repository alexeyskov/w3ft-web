import {parentPort} from 'node:worker_threads';
import {runThread} from '../web/runtime/thread-worker.mjs';
parentPort.on('message',message=>{
  if(message.type==='init')void runThread(message.options,value=>parentPort.postMessage(value));
});
