A closed chart fence is promoted:

```tugchart
{"tugchart": 1, "form": "sparkline", "values": [1, 2, 3]}
```

A look-alike language is not:

```tugchartx
{"tugchart": 1}
```

A four-backtick fence holds a three-backtick line without closing:

````tugchart
{"tugchart": 1, "form": "bar", "title": "a < b & c",
```
 "categories": ["x"], "series": [{"values": [1]}]}
````

An unclosed fence at the end of the document stays code:

```tugchart
{"tugchart": 1, "form": "sparkline", "values": [4, 5
