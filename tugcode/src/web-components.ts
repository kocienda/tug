// Web frontend component data type scaffolding (UI-facing records only).
// These interfaces describe the data shapes consumed by web UI components.
// Pure type definitions; no runtime logic.

import type { StructuredPatchHunk } from "./claude-wire.ts";

// ---------------------------------------------------------------------------
// Session and tool tracking
// ---------------------------------------------------------------------------

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: string;
  owner?: string;
  blockedBy?: string[];
}

export interface McpServerStatus {
  name: string;
  status: string;
  tools: Array<{ name: string; description?: string }>;
}

export interface SessionState {
  sessionId: string;
  cumulativeCost: number;
  pendingControlRequests: Record<string, unknown>;
  activeContentBlocks: Record<string, unknown>;
  toolUseMap: Record<string, { toolName: string; input: Record<string, unknown> }>;
  toolUseResultMap: Record<string, { output: string; isError: boolean; structured?: Record<string, unknown> }>;
  taskList: TaskItem[];
  mcpServers: McpServerStatus[];
  currentModel: string;
  permissionMode: string;
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

export interface SettingsPanelData {
  currentModel: string;
  availableModels: string[];
  currentPermissionMode: string;
  availablePermissionModes: string[];
  fastModeState: string;
  outputStyle: string;
}

// ---------------------------------------------------------------------------
// Help panel
// ---------------------------------------------------------------------------

export interface SlashCommandEntry {
  name: string;
  category: "local" | "agent" | "skill";
  description?: string;
}

export interface HelpPanelData {
  tools: Array<{ name: string; description?: string }>;
  slashCommands: SlashCommandEntry[];
  skills: Array<{ name: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
  plugins: Array<{ name: string; description?: string }>;
  version: string;
}

// ---------------------------------------------------------------------------
// Keybindings
// ---------------------------------------------------------------------------

export interface KeybindingsConfig {
  bindings: Array<{ key: string; action: string; context?: string }>;
}

// ---------------------------------------------------------------------------
// Context gauge (token usage display)
// ---------------------------------------------------------------------------

export interface ContextGaugeData {
  model: string;
  usedTokens: number;
  totalTokens: number;
  percentage: number;
  categories?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
}

// ---------------------------------------------------------------------------
// Cost display
// ---------------------------------------------------------------------------

export interface CostDisplayData {
  totalCostUsd: number;
  perTurnDelta?: number;
  durationMs: number;
  durationApiMs: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
}

// ---------------------------------------------------------------------------
// Diff viewer
// ---------------------------------------------------------------------------

export interface DiffViewerData {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
  newFile: string | null;
  editType: "edit" | "create" | "overwrite";
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

export interface TaskListData {
  tasks: TaskItem[];
  activeTaskId?: string;
}

// ---------------------------------------------------------------------------
// Permission dialog
// ---------------------------------------------------------------------------

export interface PermissionDialogData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
  permissionSuggestions?: unknown[];
}

// ---------------------------------------------------------------------------
// Question form (AskUserQuestion)
// ---------------------------------------------------------------------------

export interface QuestionFormData {
  requestId: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export interface SessionManagementData {
  sessions: Array<{ id: string; timestamp?: number }>;
  currentSessionId: string;
  // Per D10 (#d10-session-forking): whether fork/continue are supported.
  supportsFork: boolean;
  supportsContinue: boolean;
}
