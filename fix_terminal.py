content = open(r"C:\Trading Algo\NoVo v.fast\main.py", encoding="utf-8").read()

fixes = [
    # novo_core_commands — the specific example
    (
        "await log_telemetry(\"[BOOT] 🎧 Redis Command Listener online. Channel: 'novo_core_commands'\")",
        "await log_telemetry(\"[SYSTEM] Command listener online.\")"
    ),
    # SPY Sniper Engine internal name
    (
        "await log_telemetry(\"[SYSTEM] 🟢 SPY Sniper Engine Online. Pure Options Flow Sniper.\")",
        "await log_telemetry(\"[SYSTEM] Signal engine online.\")"
    ),
    # RAM VAULT + soul lock
    (
        "await log_telemetry(f\"🧹 [RAM VAULT] Cleared {len(live_keys)} dead option streams, {len(mem_keys)} memory caches, and dropped system soul lock.\")",
        "await log_telemetry(\"[SYSTEM] Memory initialized.\")"
    ),
    # RAM VAULT + Redis
    (
        "await log_telemetry(f\"⚙️ [RAM VAULT] Synced {len(live_symbols)} active position states from Redis.\")",
        "await log_telemetry(f\"[SYSTEM] {len(live_symbols)} active position(s) restored.\")"
    ),
    # CORTEX + RAM Vault
    (
        "await log_telemetry(\"💾 [CORTEX] 🧠 Global Macro State updated in RAM Vault.\")",
        "await log_telemetry(\"[SYSTEM] Macro state refreshed.\")"
    ),
    # Macro Vision Night Watch
    (
        "await log_telemetry(\"[SYSTEM] 🦉 Macro Vision Night Watch Online.\")",
        "await log_telemetry(\"[SYSTEM] Night watch active.\")"
    ),
    # RVOL pre-warmed — reveals RVOL internals
    (
        "await log_telemetry(f\"[RVOL] ✅ Baseline pre-warmed from boot tape ({len(_prewarm_windows)} windows, median={_baseline_seed:.0f})\")",
        "await log_telemetry(\"[SYSTEM] Volume baseline calibrated.\")"
    ),
    # RVOL tape too thin
    (
        "await log_telemetry(\"[RVOL] ℹ️ Tape too thin to pre-warm — RVOL builds from first live ticks.\")",
        "await log_telemetry(\"[SYSTEM] Volume baseline building from live data.\")"
    ),
    # RVOL cold boot
    (
        "await log_telemetry(\"[RVOL] ℹ️ Cold boot — RVOL baseline builds from first live ticks.\")",
        "await log_telemetry(\"[SYSTEM] Volume baseline building from live data.\")"
    ),
    # RVOL pre-warm error
    (
        "await log_telemetry(f\"[RVOL] ⚠️ Pre-warm error (non-critical): {_prewarm_err}\")",
        "await log_telemetry(\"[SYSTEM] Volume baseline init skipped (non-critical).\")"
    ),
    # Market Breadth Engine
    (
        "await log_telemetry(\"[SYSTEM] 🌐 Market Breadth Engine Online.\")",
        "await log_telemetry(\"[SYSTEM] Breadth monitoring online.\")"
    ),
    # CORTEX tactical heartbeat — bias value is already in Signal Intelligence panel
    (
        "await log_telemetry(f\"[CORTEX] 👁️ Tactical Heartbeat Updated: {LAST_VISUAL_BIAS['visual_bias']}\")",
        "await log_telemetry(\"[SYSTEM] Tactical bias updated.\")"
    ),
    (
        "await log_telemetry(f\"[CORTEX] 👁️ Manual Snap — Bias Updated: {LAST_VISUAL_BIAS['visual_bias']}\")",
        "await log_telemetry(\"[SYSTEM] Bias manually refreshed.\")"
    ),
    # VALIDATOR boot trigger — mentions apex backtest and Redis
    (
        "await log_telemetry(\"🔬 [VALIDATOR] Sunday auto-validation triggered (60-day apex backtest)...\")",
        "await log_telemetry(\"[VALIDATOR] Weekly performance review triggered.\")"
    ),
    (
        "await log_telemetry(\"🔬 [VALIDATOR] No apex stats in Redis — triggering startup validation (60-day backtest)...\")",
        "await log_telemetry(\"[VALIDATOR] Startup validation triggered.\")"
    ),
    # RVOL DIAG — raw signal values every minute, suppress to console only
    (
        """                await log_telemetry(
                    f"🔎 [RVOL DIAG] raw={raw_velocity:.0f} | baseline={baseline_vol:.0f} | "
                    f"n={len(volume_history)} | rvol={rvol:.2f} | floor={RVOL_BASELINE_FLOOR:.0f}"
                )""",
        """                print(
                    f"🔎 [RVOL DIAG] raw={raw_velocity:.0f} | baseline={baseline_vol:.0f} | "
                    f"n={len(volume_history)} | rvol={rvol:.2f} | floor={RVOL_BASELINE_FLOOR:.0f}"
                )"""
    ),
    # NEAR-MISS — Apex score, RVOL, imbalance, threshold every 30s
    (
        """                        await log_telemetry(
                            f"🔬 [NEAR-MISS] Apex {apex_score:.1f} cleared floor "
                            f"({thresh_confluence:.0f}) but blocked by: {blockers[0]} "
                            f"| RVOL {rvol:.2f}x | Imb {imbalance:.1f}%"
                        )""",
        """                        print(
                            f"🔬 [NEAR-MISS] Apex {apex_score:.1f} cleared floor "
                            f"({thresh_confluence:.0f}) but blocked by: {blockers[0]} "
                            f"| RVOL {rvol:.2f}x | Imb {imbalance:.1f}%"
                        )"""
    ),
]

for old, new in fixes:
    if old in content:
        content = content.replace(old, new)
        print("Fixed: " + old[:70].strip().encode("ascii", "replace").decode())
    else:
        print("NOT FOUND: " + old[:70].strip().encode("ascii", "replace").decode())

open(r"C:\Trading Algo\NoVo v.fast\main.py", "w", encoding="utf-8").write(content)
print("done")
