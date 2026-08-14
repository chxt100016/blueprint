# context/rpc

外部 HTTP 接口的采样入口。人往这里贴 curl,`bp snapshot pull rpc` 逐条发出去,
把响应整理成接口文档写进 `blueprint/snapshot/rpc/`。

```
blueprint/context/rpc/<capability>/<外部系统>.md
```

`<capability>` 与 `product/<capability>/` 同名,`<外部系统>` 自己起。

## 文件格式

```markdown
---
system: order-service
base: https://api.example.com
---

## 查询订单详情

按订单号查订单主信息与商品行,下单后各环节都用它。

​```curl
curl -X GET 'https://api.example.com/orders/A1001' \
  -H 'Authorization: Bearer ${TOKEN}'
​```

status 取值:1 待支付、2 已支付、3 已取消。
```

| 位置 | 内容 |
|---|---|
| front-matter | `system`、`base`,可选,只给人看 |
| `##` 标题 | 接口名。一个 `##` 一个接口,`bp snapshot list rpc` 里的 id 是 `<capability>.<文件名>.<标题>` |
| 标题下首段 | 概要,一句话。`list` 打的就是它 |
| ```curl 围栏 | 请求原文,一节一个。原样执行,不做重组 |
| 围栏之外的文字 | 人工备注(值域、坑),原样搬进快照 |

`${VAR}` 取环境变量,取不到就把字面量交给 sh。

## 只贴查询接口

pull 会真的把请求发出去。贴一条 POST 下单的 curl,每跑一次 pull 就真下一单——
数据库快照那边有 pg_dump 的只读保证,这里没有,由贴的人自己把关。

## 采样是样本,不是契约

一次响应推得出字段路径、类型、嵌套结构,推不出可选字段与值域全集。所以快照里:

- **必现** 记 `2/3` 这种出现次数比,`3/3` 才可能是必填
- **observed** 是观察到的值,不是枚举全集。同一接口可以贴不同参数多采几次,值会累积合并

拿不准的字段含义与值域,走澄清问人,不要凭 observed 猜。

## 会入库

`blueprint/snapshot/rpc/` 跟着仓库走,里面是真实响应内容,请求头里的 token 也原样保留。
采样用什么环境、贴什么凭据,自己把控。
