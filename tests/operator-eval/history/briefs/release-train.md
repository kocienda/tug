# The release train

Harbor ships from a branch cut every second Tuesday, and what is not on it by noon waits for the next one.

## What we decided

A release is one signed disk image, notarized, published through the update feed once a person has run it for a day. A hotfix is the same train with a shorter wait, never a separate path through signing.

## Who holds it

Whoever cut the branch holds the release until it is out, and that person alone may delay it.
