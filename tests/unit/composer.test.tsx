import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../../src/app/components/Composer";

beforeEach(() => sessionStorage.clear());
it("does not send while confirming an IME composition", () => {
  const onSend = vi.fn(async () => undefined);
  render(<Composer disabled={false} onSend={onSend} />);
  const input = screen.getByLabelText("你的行动");
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", isComposing: false });
  expect(onSend).toHaveBeenCalledWith("你好");
});

it("allows drafting while generation runs and exposes a real stop action", async () => {
  const onStop = vi.fn();
  const onSend = vi.fn(async () => undefined);
  const user = userEvent.setup();
  render(<Composer sessionKey="a" disabled phase="running" onSend={onSend} onStop={onStop} />);
  await user.type(screen.getByLabelText("你的行动"), "下一条{Enter}");
  expect(onSend).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("lightrp:draft:a")).toBe("下一条");
  await user.click(screen.getByRole("button", { name: "停止生成" }));
  expect(onStop).toHaveBeenCalledOnce();
});

it("does not promise cancellation after committing starts", () => {
  render(<Composer disabled phase="committing" onSend={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByRole("button", { name: "正在保存" })).toBeDisabled();
  expect(screen.getByLabelText("你的行动")).toBeEnabled();
});

it("restores the correct per-session draft on remount", () => {
  sessionStorage.setItem("lightrp:draft:a", "session A");
  sessionStorage.setItem("lightrp:draft:b", "session B");
  const { rerender } = render(<Composer key="a" sessionKey="a" disabled={false} onSend={vi.fn()} />);
  expect(screen.getByLabelText("你的行动")).toHaveValue("session A");
  rerender(<Composer key="b" sessionKey="b" disabled={false} onSend={vi.fn()} />);
  expect(screen.getByLabelText("你的行动")).toHaveValue("session B");
});
