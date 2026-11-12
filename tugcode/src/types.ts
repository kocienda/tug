// IPC message type definitions (tugcast ↔ tugcode stdin/stdout)

// The inbound client → tugcode contract ([#step-13c1]) is authored once in
// `@tugproto/inbound` and re-exported here so tugcode call sites keep importing
// these from `./types.ts`. ContentBlock is the Anthropic content-block shape
// carried verbatim on `user_message`. Per-type guards below derive from the
// imported types; `isInboundMessage` derives from the shared verb list.
import type {
  ContentBlock,
  ProtocolInit,
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  Interrupt,
  PermissionModeMessage,
  ModelChange,
  EffortChange,
  AddDirectory,
  SessionCommand,
  SessionStageSpec,
  StopTask,
  RequestReplay,
  ReplayWindow,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  CancelReplay,
  RewindPreview,
  SessionRewind,
  SkillsInventoryQuery,
  HooksQuery,
  SideQuestion,
  InboundMessage,
} from "@tugproto/inbound";
export type {
  ContentBlock,
  ProtocolInit,
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  Interrupt,
  PermissionModeMessage,
  ModelChange,
  EffortChange,
  AddDirectory,
  SessionCommand,
  SessionStageSpec,
  StopTask,
  RequestReplay,
  ReplayWindow,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  CancelReplay,
  RewindPreview,
  SessionRewind,
  SkillsInventoryQuery,
  HooksQuery,
  SideQuestion,
  InboundMessage,
};
export type {
  ContentBlockText,
  ContentBlockImage,
  ContentBlockImageSourceBase64,
} from "@tugproto/inbound";
export { isInboundMessage } from "@tugproto/inbound";

// The outbound tugcode → client frame contract is authored once in
// `@tugproto/outbound` and re-exported here, like the inbound contract above.
export * from "@tugproto/outbound";

// Type guards. `isInboundMessage` is the shared, verb-list-derived guard
// (re-exported at the top of this file from `@tugproto/inbound`); the per-type
// guards below narrow a known `InboundMessage` to a specific verb.
export function isProtocolInit(msg: InboundMessage): msg is ProtocolInit {
  return msg.type === "protocol_init";
}

export function isUserMessage(msg: InboundMessage): msg is UserMessage {
  return msg.type === "user_message";
}

export function isToolApproval(msg: InboundMessage): msg is ToolApproval {
  return msg.type === "tool_approval";
}

export function isQuestionAnswer(msg: InboundMessage): msg is QuestionAnswer {
  return msg.type === "question_answer";
}

export function isInterrupt(msg: InboundMessage): msg is Interrupt {
  return msg.type === "interrupt";
}

export function isPermissionMode(msg: InboundMessage): msg is PermissionModeMessage {
  return msg.type === "permission_mode";
}

export function isModelChange(msg: InboundMessage): msg is ModelChange {
  return msg.type === "model_change";
}

export function isEffortChange(msg: InboundMessage): msg is EffortChange {
  return msg.type === "effort_change";
}

export function isAddDirectory(msg: InboundMessage): msg is AddDirectory {
  return msg.type === "add_directory";
}

export function isSessionCommand(msg: InboundMessage): msg is SessionCommand {
  return msg.type === "session_command";
}

export function isStopTask(msg: InboundMessage): msg is StopTask {
  return msg.type === "stop_task";
}

export function isRequestReplay(msg: InboundMessage): msg is RequestReplay {
  return msg.type === "request_replay";
}

export function isCancelReplay(msg: InboundMessage): msg is CancelReplay {
  return msg.type === "cancel_replay";
}

export function isRewindPreview(msg: InboundMessage): msg is RewindPreview {
  return msg.type === "rewind_preview";
}

export function isSessionRewind(msg: InboundMessage): msg is SessionRewind {
  return msg.type === "session_rewind";
}

export function isSkillsInventoryQuery(
  msg: InboundMessage,
): msg is SkillsInventoryQuery {
  return msg.type === "skills_inventory_query";
}

export function isHooksQuery(msg: InboundMessage): msg is HooksQuery {
  return msg.type === "hooks_query";
}
