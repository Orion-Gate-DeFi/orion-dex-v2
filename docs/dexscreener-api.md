# Reference

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/token-profiles/latest/v1" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

## GET /token-profiles/recent-updates/v1

> Get recently updated token profiles (rate-limit 60 requests per minute)

```json
{"openapi":"3.0.3","info":{"title":"DEX Screener API","version":"1.0.0"},"servers":[{"url":"https://api.dexscreener.com"}],"paths":{"/token-profiles/recent-updates/v1":{"get":{"tags":["Token Profiles"],"summary":"Get recently updated token profiles (rate-limit 60 requests per minute)","responses":{"200":{"description":"Ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/TokenProfile"}}}}}}}},"components":{"schemas":{"TokenProfile":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"chainId":{"type":"string"},"tokenAddress":{"type":"string"},"icon":{"type":"string","format":"uri"},"header":{"type":"string","format":"uri","nullable":true},"description":{"type":"string","nullable":true},"links":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","nullable":true},"label":{"type":"string","nullable":true},"url":{"type":"string","format":"uri"}}},"nullable":true}}}}}}
```

## GET /community-takeovers/latest/v1

> Get the latest token community takeovers (rate-limit 60 requests per minute)

```json
{"openapi":"3.0.3","info":{"title":"DEX Screener API","version":"1.0.0"},"servers":[{"url":"https://api.dexscreener.com"}],"paths":{"/community-takeovers/latest/v1":{"get":{"tags":["Community Takeovers"],"summary":"Get the latest token community takeovers (rate-limit 60 requests per minute)","responses":{"200":{"description":"Ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/CommunityTakeoverResponse"}}}}}}}},"components":{"schemas":{"CommunityTakeoverResponse":{"type":"array","items":{"$ref":"#/components/schemas/CommunityTakeover"}},"CommunityTakeover":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"chainId":{"type":"string"},"tokenAddress":{"type":"string"},"icon":{"type":"string","format":"uri"},"header":{"type":"string","format":"uri","nullable":true},"description":{"type":"string","nullable":true},"links":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","nullable":true},"label":{"type":"string","nullable":true},"url":{"type":"string","format":"uri"}}},"nullable":true},"claimDate":{"type":"string","format":"date-time"}}}}}}
```

## GET /ads/latest/v1

> Get the latest ads (rate-limit 60 requests per minute)

```json
{"openapi":"3.0.3","info":{"title":"DEX Screener API","version":"1.0.0"},"servers":[{"url":"https://api.dexscreener.com"}],"paths":{"/ads/latest/v1":{"get":{"tags":["Ads"],"summary":"Get the latest ads (rate-limit 60 requests per minute)","responses":{"200":{"description":"Ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/AdsResponse"}}}}}}}},"components":{"schemas":{"AdsResponse":{"type":"array","items":{"$ref":"#/components/schemas/Ad"}},"Ad":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"chainId":{"type":"string"},"tokenAddress":{"type":"string"},"date":{"type":"string","format":"date-time"},"type":{"type":"string"},"durationHours":{"type":"number","nullable":true},"impressions":{"type":"number","nullable":true}}}}}}
```

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/token-boosts/latest/v1" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/token-boosts/top/v1" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/orders/v1/{chainId}/{tokenAddress}" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/latest/dex/pairs/{chainId}/{pairId}" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/latest/dex/search" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/token-pairs/v1/{chainId}/{tokenAddress}" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}

{% openapi src="<https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media&token=155a7049-dc39-4be1-aa19-5eeb66388513>" path="/tokens/v1/{chainId}/{tokenAddresses}" method="get" %}
[openapi-spec.yml](https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml?alt=media\&token=155a7049-dc39-4be1-aa19-5eeb66388513)
{% endopenapi %}
