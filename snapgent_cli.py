#!/usr/bin/env python3
"""Send prompts to an active Snapgent browser chat from the terminal."""

import argparse
import asyncio
import contextlib
import json
import os
import re
import shutil
import sys
import textwrap
import time

try:
    import readline  # Enable arrow-key cursor editing in interactive terminals.
except ImportError:
    pass  # Windows console input provides its own line editing.

try:
    import websockets
except ImportError:
    raise SystemExit("Install the bridge dependency first: python3 -m pip install websockets")


class TerminalUI:
    FRAMES = "◐◓◑◒"
    BANNER = (
        "  ███████╗███╗   ██╗ █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗",
        "  ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
        "  ███████╗██╔██╗ ██║███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║",
        "  ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ██║   ██║██╔══╝  ██║╚██╗██║   ██║",
        "  ███████║██║ ╚████║██║  ██║██║     ╚██████╔╝███████╗██║ ╚████║   ██║",
        "  ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
    )

    def __init__(self):
        self.terminal = sys.stdout.isatty() and sys.stderr.isatty()
        self.color = self.terminal and os.environ.get("NO_COLOR") is None and os.environ.get("TERM") != "dumb"
        self.spinner = None

    def paint(self, value, code):
        return f"\033[{code}m{value}\033[0m" if self.color else value

    def header(self):
        if not self.terminal:
            return
        print()
        for line in self.BANNER:
            print(self.paint(line, "1;34"))
        print(self.paint("  ✦ browser extension + local bridge for VS Code and MCP", "1;34"))
        print(self.paint("  Type a prompt • /exit to quit\n", "2"))

    def prompt(self):
        return self.paint("  snapgent ❯ ", "1;36") if self.terminal else "snapgent> "

    async def wait(self, label="Waiting for AI response"):
        await self.clear()
        if self.terminal:
            self.spinner = asyncio.create_task(self._animate(label))

    async def _animate(self, label):
        started = time.monotonic()
        index = 0
        while True:
            elapsed = int(time.monotonic() - started)
            frame = self.paint(self.FRAMES[index % len(self.FRAMES)], "1;36")
            sys.stderr.write(f"\r\033[2K  {frame} {label} {self.paint(f'{elapsed}s', '2')}")
            sys.stderr.flush()
            index += 1
            await asyncio.sleep(0.12)

    async def clear(self):
        if self.spinner:
            self.spinner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.spinner
            self.spinner = None
            sys.stderr.write("\r\033[2K")
            sys.stderr.flush()

    def tool(self, data):
        name = data.get("name", "tool")
        if data.get("phase") == "start":
            line = f"  {self.paint('⚙', '33')}  {name}"
        else:
            mark = self.paint("✓" if data.get("ok") else "✗", "32" if data.get("ok") else "31")
            summary = str(data.get("summary") or "completed").replace("\n", " ")[:160]
            line = f"  {mark}  {name}  {self.paint(summary, '2')}"
        print(line, file=sys.stderr, flush=True)

    @staticmethod
    def _plain_inline(value):
        value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", value)
        value = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda match: match.group(1) or match.group(2), value)
        return value

    def _render_answer(self, value):
        width = max(40, shutil.get_terminal_size((88, 24)).columns - 4)
        lines = []
        paragraph = []
        fence = None

        def push(line):
            if line or (lines and lines[-1]):
                lines.append(line)

        def flush_paragraph():
            if paragraph:
                text = self._plain_inline(" ".join(paragraph))
                push(textwrap.fill(text, width=width, initial_indent="  ", subsequent_indent="  ",
                                   break_long_words=False, break_on_hyphens=False))
                paragraph.clear()

        source_lines = (value or "").splitlines()
        tree_branch = re.compile(r"^[ \t│]*[├└]──[ \t]+")
        tree_root = re.compile(r"^[^\s│├└].*[/\\]$")
        index = 0
        while index < len(source_lines):
            source = source_lines[index]
            index += 1
            stripped = source.strip()
            # Some chat sites expose a code block's "Plain text" label as a
            # separate line. Skip that label only when a directory tree follows.
            if (stripped.lower() == "plain text" and index + 1 < len(source_lines)
                    and tree_root.fullmatch(source_lines[index].strip())
                    and tree_branch.match(source_lines[index + 1])):
                continue
            if (tree_root.fullmatch(stripped) and index < len(source_lines)
                    and tree_branch.match(source_lines[index])):
                flush_paragraph()
                push("")
                push("  " + source)
                while index < len(source_lines) and tree_branch.match(source_lines[index]):
                    push("  " + source_lines[index])
                    index += 1
                push("")
                continue
            marker = re.match(r"^(`{3,}|~{3,})(.*)$", stripped)
            if marker:
                flush_paragraph()
                if fence is None:
                    fence = marker.group(1)
                    language = marker.group(2).strip()
                    push(self.paint(f"  ┌─ {language or 'code'} " + "─" * max(1, width - len(language or "code") - 7), "2"))
                elif marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                    push(self.paint("  └" + "─" * max(1, width - 3), "2"))
                    fence = None
                else:
                    push("  │ " + source)
                continue
            if fence is not None:
                push("  │ " + source)
                continue
            if not stripped:
                flush_paragraph()
                push("")
                continue
            heading = re.match(r"^#{1,6}\s+(.+)$", stripped)
            if heading:
                flush_paragraph()
                push("")
                push("  " + self.paint(self._plain_inline(heading.group(1)), "1;36"))
                push("")
                continue
            if re.fullmatch(r"(?:-{3,}|\*{3,}|_{3,})", stripped):
                flush_paragraph()
                push(self.paint("  " + "─" * min(width - 2, 60), "2"))
                continue
            bullet = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.+)$", source)
            if bullet:
                flush_paragraph()
                indent = " " * min(len(bullet.group(1)), 6)
                prefix = f"  {indent}{bullet.group(2)} "
                push(textwrap.fill(self._plain_inline(bullet.group(3)), width=width,
                                   initial_indent=prefix, subsequent_indent=" " * len(prefix),
                                   break_long_words=False, break_on_hyphens=False))
                continue
            if stripped.startswith(">"):
                flush_paragraph()
                quote = self._plain_inline(stripped.lstrip("> "))
                push(textwrap.fill(quote, width=width, initial_indent="  │ ", subsequent_indent="  │ ",
                                   break_long_words=False, break_on_hyphens=False))
                continue
            if stripped.startswith("|") and stripped.endswith("|"):
                flush_paragraph()
                push("  " + source.strip())
                continue
            # Provider text readers already split DOM paragraphs into lines.
            # Keep those boundaries instead of joining separate items together.
            flush_paragraph()
            paragraph.append(stripped)
        flush_paragraph()
        if fence is not None:
            push(self.paint("  └" + "─" * max(1, width - 3), "2"))
        return "\n".join(lines).strip("\n")

    def answer(self, value):
        if self.terminal:
            print(f"\n  {self.paint('✦ Response', '1;36')}")
            print(self.paint("  ──────────────────────────────────────", "2"))
            print(self._render_answer(value))
            print()
        else:
            print(value or "")

    def error(self, value):
        print(f"  {self.paint('✗', '31')} {value}", file=sys.stderr)


async def request(socket, kind, ui, **fields):
    await socket.send(json.dumps({"type": kind, "id": 1, **fields}, ensure_ascii=False))
    await ui.wait("Finding chat sessions" if kind == "terminal_sessions" else "Sending prompt")
    try:
        while True:
            message = json.loads(await socket.recv())
            if message.get("type") == "error" and message.get("id") == 1:
                raise RuntimeError(message.get("error", "Bridge error"))
            if message.get("type") != "terminal_event":
                continue
            event, data = message.get("event"), message.get("data")
            if event == "sessions":
                return data or []
            if event == "accepted":
                await ui.wait(f"Waiting for {data.get('provider', 'AI')} response")
            elif event == "tool":
                await ui.clear()
                ui.tool(data)
                await ui.wait("Running tool" if data.get("phase") == "start" else "Waiting for AI response")
            elif event == "done":
                await ui.clear()
                ui.answer(data)
                return
            elif event == "error":
                raise RuntimeError(str(data))
    finally:
        await ui.clear()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="*", help="Prompt text; use '-' to read stdin")
    parser.add_argument("--list", action="store_true", help="List active chat tabs")
    parser.add_argument("--tab", type=int, help="Chat tab ID when multiple sessions are active")
    args = parser.parse_args()
    ui = TerminalUI()
    port = os.environ.get("ZS_BRIDGE_PORT", "17613")
    async with websockets.connect(f"ws://127.0.0.1:{port}", max_size=128 * 1024 * 1024) as socket:
        if args.list:
            sessions = await asyncio.wait_for(request(socket, "terminal_sessions", ui), timeout=10)
            for session in sessions:
                print(f"{session['id']}\t{session.get('state', 'unknown')}\t{session['title']}\t{session['url']}")
            if not sessions:
                print("No active Snapgent chat. Open a supported chat and click Start session.")
            return
        if args.prompt:
            prompt = sys.stdin.read() if args.prompt == ["-"] else " ".join(args.prompt)
            if not prompt.strip():
                raise RuntimeError("Prompt is empty.")
            await request(socket, "terminal_prompt", ui, text=prompt, tab_id=args.tab)
            return
        ui.header()
        while True:
            try:
                prompt = input(ui.prompt()).strip()
            except EOFError:
                break
            if prompt in ("/exit", "/quit"):
                break
            if prompt:
                try:
                    await request(socket, "terminal_prompt", ui, text=prompt, tab_id=args.tab)
                except RuntimeError as error:
                    ui.error(error)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (OSError, RuntimeError, asyncio.TimeoutError) as error:
        raise SystemExit(f"snapgent: {error}")
    except KeyboardInterrupt:
        raise SystemExit(130)
