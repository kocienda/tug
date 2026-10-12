before <script>alert("inline")</script> after

<script>
alert("block");
</script>

<p onclick="alert(1)" onmouseover="alert(2)" class="kept">handlers</p>

<img src="https://example.invalid/x.png" onerror="alert(3)" onload="alert(4)" alt="img">

<a href="https://example.invalid" onfocus="alert(5)" onblur="alert(6)" title="t">link</a>

<div onpointerdown="alert(7)" ondblclick="alert(8)">unlisted handlers</div>

<style>body { display: none }</style>

<p style="color: red" data-x="1" aria-label="a">styled</p>

<noscript><p>noscript content</p></noscript>

<template><p>template content</p></template>
