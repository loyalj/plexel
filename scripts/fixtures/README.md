# Check fixtures

Files the checks read, made by other tools so the checks can tell whether
Plexel reads what the rest of the world writes.

- `python-plain.zip`: Python's `zipfile`, a stored `mimetype`, a deflated
  entry and a UTF-8 name.
- `python-zip64.zip`: Python's `zipfile` with `force_zip64=True`, so its
  entry has a Zip64 local header.

Made with:

```python
import zipfile
with zipfile.ZipFile('python-plain.zip', 'w') as z:
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/x-plexel', compress_type=zipfile.ZIP_STORED)
    z.writestr('notes/hello.txt', 'Hello from Python ' * 20, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('ünïcode.txt', 'naïve', compress_type=zipfile.ZIP_DEFLATED)
with zipfile.ZipFile('python-zip64.zip', 'w') as z:
    with z.open(zipfile.ZipInfo('big.txt'), 'w', force_zip64=True) as f:
        f.write(b'zip64 ' * 50)
```

ICC profiles, made by Plexel's own colour engine, for the browser checks
that load a profile through the file picker:

- `fixture-wide-rgb.icc`: an RGB profile with Display P3's primaries,
  described as "Fixture Wide RGB" so a check can tell it from the built-in.
- `fixture-cmyk.icc`: the Generic CMYK profile's bytes, for the check that
  a CMYK profile can't be assigned to an RGB document.

Made with `Cms.rgbProfile` and `ProfileRegistry.builtin('generic-cmyk').bytes()`.
