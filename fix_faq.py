content = open(r"C:\Trading Algo\novo-store\public\index.html", encoding="utf-8").read()

fixes = [
    # broker FAQ — remove signal component names from parenthetical
    (
        "(tape imbalance, RVOL, GEX)",
        ""
    ),
    # watch screen FAQ — remove service count
    (
        "NoVo runs as three persistent Windows services",
        "NoVo runs as persistent background services"
    ),
    # setup FAQ — exact path
    (
        "Unzip to <code>C:\\Trading Algo\\NoVo</code> — the services and shortcuts are pre-configured for that exact path.",
        "Unzip to the required folder — the services and shortcuts are pre-configured for that exact path."
    ),
    # setup FAQ — Redis, NSSM, three services
    (
        "installs Python dependencies, Redis, NSSM, registers all three services, and starts the system.",
        "installs dependencies, registers all background services, and starts the system."
    ),
    # setup modal step 2 — exact path
    (
        "Extract the zip to <code>C:\\Trading Algo\\NoVo</code> — the services and shortcuts are pre-configured for that exact path.",
        "Extract the zip to the required folder — setup will confirm the location during installation."
    ),
    # setup modal step 4 — Redis, three services
    (
        "Redis, the three background services, the firewall rule, your desktop shortcuts — all installed and started automatically. No babysitting required.",
        "All background services, the firewall rule, and your desktop shortcuts — installed and started automatically. No babysitting required."
    ),
    # setup modal step 5 — port 8000
    (
        "Locally at <code>https://127.0.0.1:8000</code>, or your Tailscale URL if you set up remote access.",
        "Locally via the dashboard shortcut on your desktop, or your Tailscale URL if you set up remote access."
    ),
]

for old, new in fixes:
    if old in content:
        content = content.replace(old, new)
        print(f"Fixed: {old[:70]}")
    else:
        print(f"NOT FOUND: {old[:70]}")

open(r"C:\Trading Algo\novo-store\public\index.html", "w", encoding="utf-8").write(content)
print("done")
