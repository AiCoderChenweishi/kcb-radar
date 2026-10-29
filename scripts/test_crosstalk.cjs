'use strict';
// 串台检测验证：复现当初真实抓到的污染样本
const P = require('../src/parser');
const { loadCached } = require('../src/universe');

const uni = loadCached();
console.log('全市场名单:', uni.length, '家');
const ct = P.buildCrossTalkDetector(uni);

const target = { name: '亚虹医药', code: '688176.SH' };

const contaminated = '公司为国产呼吸道快检行业领导者，产品品类多样且市场竞争力持续提升，给予公司26年30x PE(可比公司Wind一致预期均值26x)，对应目标价37.68元(前值40.23元，对应25年21x PE)。英诺特：年报点评：核心业务积极放量，新业务有序拓展 (华泰证券 代雯,高鹏,杨昌源) 调整25-27年EPS至1.92/2.21/2.53元。首次评级，给予"增持"评级。';

const legit = '亚虹医药：江苏亚虹医药科技股份有限公司关于与Theramex公司签署有条件的独家授权许可协议的公告。本次交易亚虹医药将获得包括1500万美元首付款、1100万美元近期注册里程碑付款。';

const generic = '科创板收盘播报：科创综指涨2.13% 电器仪表股表现强势';

console.log('污染样本 ->', JSON.stringify(ct(target, contaminated)), '期望 status=crosstalk');
console.log('正常样本 ->', JSON.stringify(ct(target, legit)), '期望 status=matched');
console.log('泛行业   ->', JSON.stringify(ct(target, generic)), '期望 status=weak');
console.log('英诺特名下 ->', JSON.stringify(ct({ name: '英诺特', code: '688253.SH' }, contaminated)), '期望 status=matched');
