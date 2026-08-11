# context

这个目录放 AI 拿不到、也推不出来的信息。人写,脚本与 skill 只读,不做过期校验。

典型内容:

- `db.yaml` —— 数据库连接。`bp schema pull` 读 `main.url`。
- 外部系统的接口地址、约定、联系人
- 业务背景里那些「大家都知道但没写下来」的前提

## db.yaml

```yaml
main:
  url: postgres://readonly:pwd123@10.0.1.20:5432/app_prod
  schema: public

staging:
  url: ${STAGING_DATABASE_URL}
  schema: public
```

`${XXX}` 做环境变量插值,取不到则报错;不含占位符的原样使用,允许明文。

**`db.yaml` 已被 `bp init` 写进 `.gitignore`,不要入库。**

`bp schema pull` 连的是 `main.url`,而 todo 里的 SQL 也要人在同一个库上执行。
开发库与生产不一致时 `schema check` 的判定不可靠。
