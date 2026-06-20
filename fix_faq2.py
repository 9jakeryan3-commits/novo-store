content = open(r"C:\Trading Algo\novo-store\public\index.html", encoding="utf-8").read()

fixes = [
    (
        "All three NoVo services are registered via NSSM and configured to restart automatically on reboot.",
        "All NoVo services are configured to restart automatically on reboot."
    ),
    (
        r"Unzip to C:\Trading Algo\NoVo, rename",
        "Unzip to the required folder, rename"
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
