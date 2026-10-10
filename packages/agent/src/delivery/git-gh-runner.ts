export interface DeliverySubprocessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface DeliveryGitGhRunner {
  git(args: readonly string[], cwd: string, timeoutMs?: number): Promise<DeliverySubprocessResult>;
  gh(args: readonly string[], cwd: string, timeoutMs?: number): Promise<DeliverySubprocessResult>;
  exec(command: string, cwd: string, timeoutMs?: number, env?: Record<string, string>): Promise<DeliverySubprocessResult>;
}

const TOKEN_PATTERNS = [
  /https?:\/\/[^@\s"'<>\\]+@/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{50,}/g,
  /Bearer\s+[a-zA-Z0-9_.-]+/gi,
];

/**
 * 脱敏字符串中的敏感 token 与 URL 凭据，防止泄漏到控制台或日志。
 */
export function sanitizeCredentials(text: string): string {
  let sanitized = text;
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.startsWith("http://") || match.startsWith("https://")) {
        const protocol = match.startsWith("https://") ? "https://" : "http://";
        return `${protocol}***:***@`;
      }
      if (match.toLowerCase().startsWith("bearer ")) {
        return "Bearer ***";
      }
      return "***REDACTED_TOKEN***";
    });
  }
  return sanitized;
}
