import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestGuard} from '../server/requestGuard.js';
test('相同请求合并并复用，缓存结果不会被响应修改',async()=>{
  const execute=createRequestGuard();let calls=0,release;
  const task=()=>{calls++;return new Promise(r=>{release=r;});};
  const a=execute('same',task),b=execute('same',task);await Promise.resolve();release({meta:{value:1}});
  const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(y.reused,true);
  x.value.meta.value=99;const z=await execute('same',task);assert.equal(z.value.meta.value,1);
});
test('并发限额不会额外启动任务，失败后释放并发名额',async()=>{
  const execute=createRequestGuard({maxConcurrent:1});let reject;
  const a=execute('a',()=>new Promise((_,r)=>{reject=r;}));await Promise.resolve();
  await assert.rejects(()=>execute('b',()=>assert.fail('must not execute')),e=>e.status===429);
  reject(new Error('upstream'));await assert.rejects(()=>a,/upstream/);
  assert.equal((await execute('b',()=>({ok:true}))).value.ok,true);
});
test('实例日额度停止新调用但不阻止缓存，次日重置',async()=>{
  let now=Date.parse('2026-10-13T12:00:00Z');const execute=createRequestGuard({maxCalls:1,clock:()=>now});
  await execute('a',()=>1);await assert.rejects(()=>execute('b',()=>2),e=>e.status===429);
  assert.equal((await execute('a',()=>assert.fail())).reused,true);now+=86400000;
  assert.equal((await execute('b',()=>2)).value,2);
});
test('缓存过期后重新执行而不伪称实时更新',async()=>{
  let now=1000,calls=0;const execute=createRequestGuard({ttl:100,clock:()=>now});
  await execute('a',()=>++calls);now+=101;const r=await execute('a',()=>++calls);assert.equal(r.reused,false);assert.equal(r.value,2);
});
