export type SystemCommandName = "ooc" | "help" | "regenerate" | "compact" | "sync-memory";

export type SystemCommand = {
  name: SystemCommandName;
  argument: string;
};

export const SYSTEM_COMMANDS: Array<{
  name: SystemCommandName;
  usage: string;
  description: string;
}> = [
  { name: "ooc", usage: "/ooc <问题>", description: "跳出 RP 向系统助手提问，不推进场景或写入记忆" },
  { name: "help", usage: "/help", description: "显示全部系统命令" },
  { name: "regenerate", usage: "/regenerate", description: "绕过响应缓存，重新生成上一轮" },
  { name: "compact", usage: "/compact", description: "压缩当前 RP 上下文" },
  { name: "sync-memory", usage: "/sync-memory", description: "把核心记忆重新同步到 RP-mem" },
];

const COMMAND_NAMES = new Set<SystemCommandName>(SYSTEM_COMMANDS.map((command) => command.name));

export function parseSystemCommand(text: string): SystemCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase() as SystemCommandName;
  if (!COMMAND_NAMES.has(name)) return null;
  return { name, argument: (match[2] || "").trim() };
}

export function isUnknownSlashCommand(text: string): boolean {
  return text.trim().startsWith("/") && !parseSystemCommand(text);
}

export function isOocMessage(text: string): boolean {
  return parseSystemCommand(text)?.name === "ooc";
}

export function roleplayOnlyMessages<T extends { role: string; content: string }>(messages: T[]): T[] {
  const kept: T[] = [];
  let skipOocAssistant = false;
  for (const message of messages) {
    if (message.role === "user" && isOocMessage(message.content)) {
      skipOocAssistant = true;
      continue;
    }
    if (skipOocAssistant && message.role === "assistant") {
      skipOocAssistant = false;
      continue;
    }
    if (message.role === "user") skipOocAssistant = false;
    kept.push(message);
  }
  return kept;
}
