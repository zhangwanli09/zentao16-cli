/** 进程退出码，供 agent 判断失败原因（0 为成功） */
export const ExitCode = {
  General: 1,
  NotFound: 2,
  Auth: 3,
} as const;

export class ZentaoError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.General,
  ) {
    super(message);
    this.name = 'ZentaoError';
  }
}

const NOT_FOUND = /不存在|not exist|not found/i;
/** 没有所属迭代、项目、产品的访问权限时，禅道不跳 user-deny，而是返回"您无权访问该迭代！"之类的提示 */
const NO_PERMISSION = /无权|没有权限|no permission|access denied/i;

/** 把禅道的提示文字转成错误，"不存在"类提示映射为 NotFound，"无权访问"类映射为 Auth */
export function errorFromMessage(message: string, prefix = ''): ZentaoError {
  if (NOT_FOUND.test(message)) return new ZentaoError(prefix + message, ExitCode.NotFound);
  if (NO_PERMISSION.test(message)) return new ZentaoError(prefix + message, ExitCode.Auth);
  return new ZentaoError(prefix + message);
}

/**
 * 可能只是会话失效：客户端会重新登录并重试一次。
 * 如果本次运行已经登录过还是失败，说明不是会话问题，改为抛出 final。
 */
export class RetryableAuthError extends ZentaoError {
  constructor(
    message: string,
    readonly final: ZentaoError = new ZentaoError(message, ExitCode.Auth),
  ) {
    super(message, ExitCode.Auth);
    this.name = 'RetryableAuthError';
  }
}

export class SessionExpiredError extends RetryableAuthError {
  constructor() {
    super('禅道会话已失效');
    this.name = 'SessionExpiredError';
  }
}
