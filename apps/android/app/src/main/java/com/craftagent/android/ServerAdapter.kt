package com.craftagent.android

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.craftagent.android.databinding.ItemServerBinding

class ServerAdapter(
  private val onClick: (ServerEntry) -> Unit,
  private val onEdit: (ServerEntry) -> Unit,
  private val onDelete: (ServerEntry) -> Unit,
) : ListAdapter<ServerEntry, ServerAdapter.Holder>(Diff) {

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val binding = ItemServerBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    return Holder(binding)
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val server = getItem(position)
    val context = holder.binding.root.context

    holder.binding.serverName.text = server.name
    holder.binding.serverUrl.text = server.url

    val meta = buildList {
      if (server.lastUsedAt > 0) {
        add(
          context.getString(
            R.string.server_last_used,
            DateUtils.getRelativeTimeSpanString(server.lastUsedAt),
          ),
        )
      }
    }
    holder.binding.serverMeta.text = meta.joinToString(" · ")
    holder.binding.serverMeta.visibility = if (meta.isEmpty()) View.GONE else View.VISIBLE

    holder.binding.root.setOnClickListener { onClick(server) }
    holder.binding.moreButton.setOnClickListener { anchor -> showMenu(anchor, server) }
  }

  private fun showMenu(anchor: View, server: ServerEntry) {
    PopupMenu(anchor.context, anchor).apply {
      inflate(R.menu.menu_server)
      setOnMenuItemClickListener { item ->
        when (item.itemId) {
          R.id.action_edit -> { onEdit(server); true }
          R.id.action_delete -> { onDelete(server); true }
          else -> false
        }
      }
      show()
    }
  }

  class Holder(val binding: ItemServerBinding) : RecyclerView.ViewHolder(binding.root)

  private object Diff : DiffUtil.ItemCallback<ServerEntry>() {
    override fun areItemsTheSame(oldItem: ServerEntry, newItem: ServerEntry) = oldItem.id == newItem.id
    override fun areContentsTheSame(oldItem: ServerEntry, newItem: ServerEntry) = oldItem == newItem
  }
}
