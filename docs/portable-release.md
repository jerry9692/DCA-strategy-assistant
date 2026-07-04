# 便携版与缓存补丁

面向没有 Python/Node 环境、且无法访问 Yahoo Finance 的试用用户，可以发布 Windows 便携版。便携版默认启用离线模式，只读取本地 SQLite 行情缓存。

## 构建便携版

在开发机上先确保依赖已安装：

```powershell
.\start-dev.ps1 -Install
```

构建便携目录和 zip：

```powershell
.\scripts\portable\build_portable.ps1
```

输出位置：

```text
dist-portable\DCA-strategy-assistant-portable\
dist-portable\DCA-strategy-assistant-portable.zip
```

这些产物已被 `.gitignore` 忽略，不会和项目源码混在一起。

便携版里包含：

- `start-offline.bat`：启动本地服务并打开浏览器。
- `import-cache.bat`：导入缓存补丁。
- `runtime\python`：随包带走的 Python 运行环境和依赖，不依赖打包电脑上的 `.venv` 绝对路径。
- `frontend\dist`：已经构建好的前端。
- `backend\data\dca_assistant.sqlite`：可选的初始行情缓存。

## 导出缓存补丁

从开发机已有缓存里导出指定标的和日期区间：

```powershell
backend\.venv\Scripts\python.exe scripts\portable\export_cache_patch.py `
  --symbols QQQ,SPY,VOO,510300 `
  --start 2018-01-01 `
  --end 2026-06-30
```

> 示例的 `--end` 选取最近一个完整季度末，随时间漂移。请用当月
> 实际的当前日期替换以确保缓存能下载到最新数据。

默认输出到：

```text
cache-patches\dca-cache-2018-01-01-to-2026-05-30.zip
```

缓存补丁格式：

```text
dca-cache-*.zip
  manifest.json
  dca_assistant.sqlite
```

`manifest.json` 会记录生成时间、请求区间、标的列表和每个标的实际覆盖范围。

## 给朋友使用

发送两个文件：

```text
DCA-strategy-assistant-portable.zip
dca-cache-*.zip
```

对方操作：

1. 解压便携版。
2. 双击 `start-offline.bat`。
3. 如果页面提示缓存不覆盖，把 `dca-cache-*.zip` 拖到 `import-cache.bat` 上。
4. 刷新页面或重新选择日期。

## 离线模式

便携版启动脚本会设置：

```text
DCA_OFFLINE_MODE=1
```

开启后：

- 后端不会访问 Yahoo Finance。
- 如果本地缓存足够覆盖回测区间，照常运行。
- 如果缓存不够，直接提示导入更新缓存或缩短日期范围。
- `/api/assets/{symbol}/range` 的结束日期会使用该标的缓存最大日期，而不是今天。

## 注意

- API Key 仍只存在朋友自己的浏览器 localStorage，不会写入缓存补丁。
- 缓存使用 yfinance `auto_adjust=True` 的 adjusted close，和在线模式口径一致。
- 便携版 zip 可能比较大，因为包含 Python 虚拟环境；这是为了避免朋友安装依赖。
