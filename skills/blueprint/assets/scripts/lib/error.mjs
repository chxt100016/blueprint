// 预期错误与脚本缺陷的分界。
//
// 这两类在出口处必须长得完全不一样。预期错误(文档写错了、lock 版本对不上、
// 环境变量没设)是使用者能改的,照着提示改就行;脚本缺陷(ReferenceError 那类)
// 谁改文档都不会消失——AI 读到一句「serviceOf is not defined」只会去翻自己的文档,
// 一轮轮改下去,而问题在母版里。
//
// 凡是「使用者照提示能自己解决」的一律 throw BpError,其余原样抛出,
// 由 bp.mjs 打成崩溃报告。
export class BpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BpError';
  }
}
