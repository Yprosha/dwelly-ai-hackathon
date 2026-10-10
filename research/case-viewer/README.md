# Case viewer

A single-page browser for all 200 public cases across the four tracks: the event timeline per case, with the answer key blurred until you reveal it.

```bash
python3 build.py
```

This writes `index.html` next to the script. Open it in a browser. The script reads the public cases from `data/public-cases` (the four track folders); set `PUBLIC_CASES_DIR` to read them from somewhere else.
