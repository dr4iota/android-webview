#!/bin/sh

cd `dirname $0`

if [ ! -f local.config.json ]; then
    echo "Missing local.config.json; create it according to local.config.json.example"
    exit 1
fi

node copy-and-subst.mjs strings.xml.tmpl local.config.json ../app/src/main/res/values/strings.xml

echo "Make sure icons are also generated; you can use Android Studio to generate them from a single source"
echo "- Right click app/res then click new => Image Asset"
echo "- Select a single source square image in png format in Source: Path"
echo "- Then continue to wizard"

