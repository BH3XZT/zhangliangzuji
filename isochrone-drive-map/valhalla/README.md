# Valhalla 配置说明

本项目使用 **Valhalla 官方 scripted 镜像**（`ghcr.io/valhalla/valhalla-scripted:latest`），
`scripts/build_tiles.sh` 会在 `data/valhalla/` 下自动生成：

- `valhalla.json`：Valhalla 运行配置
- `valhalla_tiles/`：路由图块
- `valhalla_tiles.tar`：图块打包
- `admins.sqlite` / `timezones.sqlite`：行政/时区数据库

## 可选自定义

默认不需要 `valhalla/valhalla.json`。如需调整 `mjolnir.concurrency`、`httpd.service.port`
等参数，可在首次构建后编辑 `data/valhalla/valhalla.json`，然后重启 `valhalla` 容器：

```bash
sudo docker compose restart valhalla
```

本目录下的 `valhalla.json` 是一份可选参考示例（**不会被 compose 自动挂载**）。
如果需要使用它，请复制到 `data/valhalla/valhalla.json`；scripted 镜像的
`update_existing_config=True` 会合并/补全缺失配置项。
