# Gitea Release 是唯一分发渠道，双端包均不作正式签名

面向内网团队分发，构建产物收敛为三个附件（Windows x64 zip、macOS arm64 zip、SHA256SUMS），由 `publish_release.py` 以 tag `v<版本>`（版本号唯一来源为 pyproject）上传到自建 Gitea 的 Release。我们决定不为 Windows 购买代码签名证书（OV/EV/Azure Trusted Signing 均需组织审核、硬件私钥与年费，且新证书初期仍触发 SmartScreen 警告），也不做 Apple 公证；Windows 包未签名、macOS 包仅 ad-hoc 签名且只支持 Apple Silicon。代价是用户首次启动需手动绕过 SmartScreen 与 Gatekeeper，两个绕过步骤必须写进发布说明。签名代码路径（`sign.ps1`、`--cert`）保留但不属于默认流程，将来购证可直接启用。
