# context

这个目录放 AI 拿不到、也推不出来的信息。人写,脚本与 skill 只读,不做过期校验。

典型内容:

- `db.yaml` —— 数据库连接。`bp snapshot pull db` 读 `main.url`。
- `rpc/` —— 外部 HTTP 接口的 curl,`bp snapshot pull rpc` 按它采样。见该目录的 README.md。
- 业务背景里那些「大家都知道但没写下来」的前提

脚本读这里的输入、把结果写进 `blueprint/snapshot/`,skill 读的是 snapshot。

## db.yaml

```yaml
main:
  url: postgres://readonly:pwd123@10.0.1.20:5432/app_prod
```

只有 `main.url` 会被读,写别的键不会报错但也没有任何效果。

`${XXX}` 做环境变量插值,取不到则报错;不含占位符的原样使用,允许明文。

url 的 scheme 决定用哪个导出命令,必须写对:
`postgres://`(或 `postgresql://`)走 `pg_dump`,`mysql://`(或 `mariadb://`)走 `mysqldump`,
`sqlite://`(或 `file://`)走 `sqlite3 .schema`。这三个命令要在本机 PATH 里。

**`db.yaml` 已被 blueprint 母版的 bootstrap 写进 `.gitignore`,不要入库。**

`bp snapshot pull db` 连的是 `main.url`,而 todo 里的 SQL 也要人在同一个库上执行。
开发库与生产不一致时 `bp validate` 的表结构比对不可靠。
