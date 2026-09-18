"""One bounded, local-only MLX-LM rank. The Ellie node supplies JSON over stdin."""

import contextlib
import fcntl
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import threading
import time


def main():
    parent = os.getppid()
    request = json.loads(sys.stdin.buffer.read(65_537))
    remaining = min(120, request["expiresAt"] / 1000 - time.time())
    if remaining <= 0:
        raise ValueError("Expired lease")

    def watchdog():
        deadline = time.monotonic() + remaining
        while time.monotonic() < deadline and os.getppid() == parent:
            time.sleep(0.2)
        os._exit(124)

    threading.Thread(target=watchdog, daemon=True).start()
    model_path = Path(request["modelPath"])
    if not model_path.is_absolute() or not model_path.is_dir():
        raise ValueError("A local model directory is required")
    if request["strategy"] == "pipeline" and not (model_path / "model.safetensors.index.json").is_file():
        raise ValueError("Pipeline loading requires an indexed MLX-converted model")
    rank, size = request["rank"], request["size"]
    if not 2 <= size <= 8 or not 0 <= rank < size:
        raise ValueError("Invalid rank")
    backend = request["backend"]
    if backend not in ("ring", "jaccl"):
        raise ValueError("Invalid backend")
    if request["strategy"] not in ("pipeline", "tensor"):
        raise ValueError("Invalid shard strategy")
    if request["strategy"] == "tensor" and backend != "jaccl":
        raise ValueError("Tensor parallelism requires JACCL")
    topology = json.loads(Path(request["communicationFile"]).read_text())
    if not isinstance(topology, list) or len(topology) != size:
        raise ValueError("Topology does not match the shard plan")
    if backend == "ring":
        if any(not isinstance(row, list) or not row or
               any(not isinstance(address, str) for address in row) for row in topology):
            raise ValueError("Invalid ring hostfile")
        os.environ["MLX_HOSTFILE"] = request["communicationFile"]
    else:
        if any(not isinstance(row, list) or len(row) != size for row in topology):
            raise ValueError("Invalid JACCL device matrix")
        os.environ["MLX_IBV_DEVICES"] = request["communicationFile"]
        os.environ["MLX_JACCL_COORDINATOR"] = request["coordinator"]
    os.environ["MLX_RANK"] = str(rank)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not importlib.util.find_spec("mlx") or not importlib.util.find_spec("mlx_lm"):
        raise RuntimeError("Install MLX and MLX-LM into the configured Python environment")
    with contextlib.redirect_stdout(sys.stderr):
        from mlx_lm.utils import sharded_load
        if "tokenizer_config" not in inspect.signature(sharded_load).parameters:
            raise RuntimeError("MLX-LM must support explicit safe tokenizer configuration for sharded loading")

    # A crashed/restarted node cannot start a second rank while an older process owns this group.
    descriptor = os.open(request["lockPath"], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if request.get("checkOnly"):
            print(json.dumps({"ok": True}))
            return
        # Reserve stdout for a single bounded result, regardless of library diagnostics.
        with contextlib.redirect_stdout(sys.stderr):
            import mlx.core as mx
            from mlx_lm import stream_generate
            from mlx_lm.sample_utils import make_sampler
            from mlx_lm.utils import sharded_load

            world = mx.distributed.init(strict=True, backend=backend)
            if world.rank() != rank or world.size() != size:
                raise RuntimeError("MLX world does not match the reserved group")
            mx.random.seed(0)
            model, tokenizer = sharded_load(
                str(model_path),
                pipeline_group=world if request["strategy"] == "pipeline" else None,
                tensor_group=world if request["strategy"] == "tensor" else None,
                tokenizer_config={"trust_remote_code": False},
                trust_remote_code=False,
            )
            prompt = tokenizer.apply_chat_template(
                [{"role": "user", "content": request["prompt"]}],
                add_generation_prompt=True,
            )
            text = ""
            truncated = False
            for response in stream_generate(
                model, tokenizer, prompt, max_tokens=request["maxTokens"],
                sampler=make_sampler(temp=0.0), prefill_step_size=512,
            ):
                if rank == 0:
                    chunk = response.text
                    encoded = (text + chunk).encode("utf-8")
                    if len(encoded) > 3900:
                        truncated = True
                    text = encoded[:3900].decode("utf-8", errors="ignore")
            # No rank exits while another is still finishing GPU work.
            mx.synchronize()
            mx.eval(mx.distributed.all_sum(mx.array(1), stream=mx.cpu))
        message = (text + ("\n[Output truncated.]" if truncated else "")) if rank == 0 else "Shard completed."
        print(json.dumps({"ok": True, "message": message or "Model returned no text."}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Avoid leaking prompts, local paths, or library tracebacks into service logs.
        sys.stderr.write("Distributed MLX rank failed. Check local configuration and runtime.\n")
        sys.exit(1)
