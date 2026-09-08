# Third-party notices

## Peekr gaze model and input preprocessing

Nerve uses the pretrained `peekr.onnx` gaze model from
[HugoFara/peekr](https://github.com/HugoFara/peekr) at commit
`d3ea61e4a34ce9463d83979c286ba9a8712b514a`. The browser input adapter follows
that revision's `src/eyetracking.js` and `src/worker.js` preprocessing contract.
The model is downloaded during setup, not fetched while using the camera.
Its SHA-256 pin is
`9abc6c98ee02ee518da98777d1cd879ff9bbaf71491ed2c803a608e9740ce7fb`.

The upstream repository includes the following MIT license. No separate license
is attached to its checked-in model file. Upstream accuracy reports are not a
validation of Nerve, this adapter, or a particular person's camera setup.

```text
MIT License

Copyright (c) 2025 AryamanTaore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

ONNX Runtime Web is MIT-licensed. MediaPipe Tasks Vision is Apache-2.0-licensed.
Their packaged notices and licenses remain in the installed dependencies.
Google's Face Landmarker model is fetched from the official versioned asset URL;
see [research](docs/RESEARCH.md) for the model documentation.

This file records third-party notices, not a license grant for the entire Nerve
repository. Other dependencies retain their respective licenses.
